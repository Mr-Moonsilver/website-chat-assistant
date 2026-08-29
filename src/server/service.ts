import { spawn, type ChildProcess } from 'node:child_process';
import { Database } from 'bun:sqlite';
import type { Pool } from 'pg';

/**
 * website-chat-assistant — service serveur.
 *
 * Pont entre une app web et un agent opencode local. Architecture éprouvée
 * (leçons de l'app Budget de L'Éveil, août 2026) :
 *   · création de session : POST /session au serveur opencode (métadonnée
 *     fiable) — mais JAMAIS d'exécution par lui : son registre de modèles se
 *     perd par intermittence ;
 *   · exécution d'un message : `opencode run --session <id>` en processus
 *     suivi, garde-fou par INACTIVITÉ (pas de borne de durée fixe) ;
 *   · lecture : DIRECTEMENT dans l'état sqlite d'opencode (WAL, lecture
 *     seule, temps réel — `opencode export` tronque pendant les runs).
 *
 * ⚠ Le CLI opencode enrobe le message argv de guillemets littéraux dans son
 * état : `nettoyerTexteUtilisateur` les retire, ainsi que l'étiquette de
 * page (artefact d'acheminement) — sans quoi l'optimiste du client et la
 * ligne stockée ne se reconnaissent pas (question affichée en double).
 */

export interface ConfigAssistant {
  pool: Pool;                    // base de l'app hôte (conversations, partages, users)
  opencodeUrl?: string;          // défaut http://127.0.0.1:4996
  agent?: string;                // agent principal (défaut 'donnees')
  modele?: string;               // provider/model (défaut halcyon/qwen3.8-27b)
  projetDir?: string;            // répertoire projet opencode (défaut cwd)
  cheminDbOpencode?: string;     // défaut $XDG_DATA_HOME/opencode/opencode.db
  inactiviteMs?: number;         // kill après N ms sans progrès (défaut 5 min)
  plafondMs?: number;            // plafond absolu (défaut 30 min)
}

export interface Conversation {
  id: number;
  titre: string | null;
  page: string | null;
  creeLe: string;
  majLe: string;
  partagePar: string | null;     // nom du propriétaire si la conversation m'est partagée
  lectureSeule: boolean;
}

export interface SourceMessage { nom: string; detail: string }
export interface MessageChat { role: 'user' | 'assistant'; texte: string; date: number; sources?: SourceMessage[] }
export interface OutilActivite { nom: string; detail: string; statut: string }
export interface Activite {
  depuis: number | null;
  tokens: { entree: number; sortie: number; estime: boolean };
  outils: OutilActivite[];
  apercu: string | null;
}
export interface EtatConversation { messages: MessageChat[]; enCours: boolean; activite?: Activite }
export interface Utilisateur { id: number; nom: string; initiales: string }

/** Retire les guillemets d'enrobage du CLI puis l'étiquette de page. */
function nettoyerTexteUtilisateur(t: string): string {
  let s = t.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) s = s.slice(1, -1).trim();
  return s.replace(/^\[Page active[^\]]*\]\s*/, '').trim();
}

function detailOutil(nom: string, input: any): string {
  if (!input) return '';
  if (nom === 'bash') return String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 70);
  if (nom === 'skill') return String(input.name ?? '');
  if (nom === 'read') return String(input.path ?? '').split('/').pop() ?? '';
  if (nom === 'grep' || nom === 'glob') return String(input.pattern ?? '').slice(0, 40);
  if (nom === 'task') return String(input.description ?? input.prompt ?? '').slice(0, 60);
  return String(JSON.stringify(input)).slice(0, 50);
}

interface SessionBrute { messages: { info: any; parts: any[] }[] }

export function creerServiceAssistant(cfg: ConfigAssistant) {
  const pool = cfg.pool;
  const OC = cfg.opencodeUrl ?? 'http://127.0.0.1:4996';
  const AGENT = cfg.agent ?? 'donnees';
  const MODELE = cfg.modele ?? 'halcyon/qwen3.8-27b';
  const DIR = cfg.projetDir ?? process.cwd();
  const CHEMIN_DB = cfg.cheminDbOpencode
    ?? `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/opencode/opencode.db`;
  const INACTIVITE = cfg.inactiviteMs ?? 5 * 60_000;
  const PLAFOND = cfg.plafondMs ?? 30 * 60_000;

  const runsActifs = new Map<string, { p: ChildProcess; debut: number }>();
  const derniersEchecs = new Map<string, string>();

  let ocDb: Database | null = null;
  function db(): Database | null {
    if (ocDb) return ocDb;
    try { ocDb = new Database(CHEMIN_DB, { readonly: true }); } catch { ocDb = null; }
    return ocDb;
  }

  function lireSession(sid: string): SessionBrute | null {
    const d = db();
    if (!d) return null;
    try {
      const ms = d.query('select id, time_created, data from message where session_id = ? order by time_created')
        .all(sid) as { id: string; time_created: number; data: string }[];
      return {
        messages: ms.map((m) => ({
          info: { ...JSON.parse(m.data), id: m.id },
          parts: (d!.query('select data from part where message_id = ? order by rowid').all(m.id) as { data: string }[])
            .map((p) => JSON.parse(p.data)),
        })),
      };
    } catch (e) {
      ocDb = null;
      console.error('chat-assistant: lecture sqlite opencode :', e);
      return null;
    }
  }

  async function ocCreerSession(): Promise<{ id: string }> {
    const [providerID, ...reste] = MODELE.split('/');
    const res = await fetch(`${OC}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: AGENT,
        model: { providerID, id: reste.join('/') },
        location: { directory: DIR },
      }),
    });
    if (!res.ok) throw new Error(`opencode session: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    return body?.data ?? body;
  }

  /** Messages affichables + sources (outils du tour) attachées à la réponse. */
  function versMessages(exporte: SessionBrute | null): MessageChat[] {
    const ms: any[] = exporte?.messages ?? [];
    const liste: MessageChat[] = [];
    let sourcesTour: SourceMessage[] = [];
    for (const m of ms) {
      const info = m.info ?? m;
      const role = (info.role ?? info.type) as 'user' | 'assistant';
      const parts = m.parts ?? [];
      if (role === 'user') {
        sourcesTour = [];
        const texte = nettoyerTexteUtilisateur(
          parts.filter((p: any) => p.type === 'text').map((p: any) => p.text ?? '').join(''));
        if (texte) liste.push({ role, texte, date: info.time?.created ?? 0 });
        continue;
      }
      if (role !== 'assistant') continue;
      for (const p of parts) {
        if (p.type === 'tool') {
          const nom = p.tool ?? p.name ?? 'outil';
          sourcesTour.push({ nom, detail: detailOutil(nom, p.state?.input) });
        }
      }
      const texte = info.error
        ? `⚠ ${String(info.error?.message ?? 'Erreur du modèle')}`
        : parts.filter((p: any) => p.type === 'text').map((p: any) => p.text ?? '').join('').trim();
      if (texte) {
        liste.push({
          role, texte, date: info.time?.created ?? 0,
          sources: sourcesTour.length ? [...sourcesTour] : undefined,
        });
      }
    }
    // dédoublonnage défensif des messages utilisateur consécutifs identiques
    return liste.filter((m, i) => !(m.role === 'user' && i > 0
      && liste[i - 1].role === 'user' && liste[i - 1].texte === m.texte));
  }

  /**
   * Activité du tour EN COURS. Ancrée sur le DÉBUT DU RUN (pas sur la vue
   * sqlite, en retard de quelques secondes au démarrage — sans quoi les
   * compteurs affichent le tour précédent jusqu'à la première écriture).
   */
  function extraireActivite(exporte: SessionBrute, debutRun?: number): Activite {
    const ms = exporte.messages;
    let dernierUser = -1;
    for (let i = ms.length - 1; i >= 0; i--) {
      if (((ms[i].info.role ?? ms[i].info.type)) === 'user') { dernierUser = i; break; }
    }
    const ancre = debutRun ?? (dernierUser >= 0 ? (ms[dernierUser].info.time?.created ?? null) : null);
    const activite: Activite = {
      depuis: ancre,
      tokens: { entree: 0, sortie: 0, estime: false },
      outils: [],
      apercu: null,
    };
    // seuls les messages du tour courant comptent (créés après l'ancre)
    const tour = ms.filter((m) => (m.info.time?.created ?? 0) >= (ancre ?? 0) - 2000);
    for (const m of tour) {
      const info = m.info;
      if ((info.role ?? info.type) !== 'assistant') continue;
      const t = info.tokens;
      const termine = Boolean(info.time?.completed) && t && Number(t.output ?? 0) + Number(t.reasoning ?? 0) > 0;
      if (termine) {
        activite.tokens.entree += Number(t.input ?? 0) + Number(t.cache?.read ?? 0);
        activite.tokens.sortie += Number(t.output ?? 0) + Number(t.reasoning ?? 0);
      } else {
        // étape en cours : les parts grossissent pendant le streaming — ~4 c/token
        const chars = (m.parts ?? []).reduce((n: number, q: any) =>
          n + ((q.type === 'text' || q.type === 'reasoning') ? String(q.text ?? '').length : 0), 0);
        if (chars > 0) { activite.tokens.sortie += Math.round(chars / 4); activite.tokens.estime = true; }
      }
      for (const p of (m.parts ?? [])) {
        if (p.type === 'tool') {
          const nom = p.tool ?? p.name ?? 'outil';
          activite.outils.push({ nom, detail: detailOutil(nom, p.state?.input), statut: p.state?.status ?? 'running' });
        } else if (p.type === 'text' || p.type === 'reasoning') {
          const q = String(p.text ?? '').trim();
          if (q) activite.apercu = (p.type === 'reasoning' ? '🤔 ' : '') + q.slice(-220);
        }
      }
    }
    return activite;
  }

  // ── conversations ──────────────────────────────────────────────────────────

  async function listerConversations(userId: number): Promise<Conversation[]> {
    const { rows } = await pool.query(
      `select c.id, c.titre, c.page, c.cree_le as "creeLe", c.maj_le as "majLe",
              null as "partagePar", false as "lectureSeule"
       from assistant_conversation c where c.user_id = $1
       union all
       select c.id, c.titre, c.page, c.cree_le, c.maj_le, u.name, true
       from assistant_partage p
       join assistant_conversation c on c.id = p.conversation_id
       join users u on u.id = c.user_id
       where p.destinataire_id = $1
       order by "majLe" desc limit 40`,
      [userId]
    );
    return rows;
  }

  async function creerConversation(userId: number, page: string | null): Promise<Conversation> {
    const session = await ocCreerSession();
    const { rows } = await pool.query(
      `insert into assistant_conversation (user_id, oc_session_id, page)
       values ($1, $2, $3)
       returning id, titre, page, cree_le as "creeLe", maj_le as "majLe"`,
      [userId, session.id, page]
    );
    return { ...rows[0], partagePar: null, lectureSeule: false };
  }

  /** Session opencode + droits : lecture = propriétaire ou destinataire ; écriture = propriétaire. */
  async function sessionDe(userId: number, conversationId: number, ecriture: boolean): Promise<string> {
    const { rows } = await pool.query(
      `select c.oc_session_id, c.user_id,
              exists(select 1 from assistant_partage p where p.conversation_id = c.id and p.destinataire_id = $2) as partagee
       from assistant_conversation c where c.id = $1`,
      [conversationId, userId]
    );
    const c = rows[0];
    if (!c || (c.user_id !== userId && !(!ecriture && c.partagee))) {
      throw Object.assign(new Error('Conversation introuvable'), { statut: 404 });
    }
    return c.oc_session_id;
  }

  async function listerMessages(userId: number, conversationId: number): Promise<EtatConversation> {
    const sid = await sessionDe(userId, conversationId, false);
    const exporte = lireSession(sid);
    const messages = versMessages(exporte);
    const run = runsActifs.get(sid);
    const echec = derniersEchecs.get(sid);
    if (echec && !run) messages.push({ role: 'assistant', texte: `⚠ ${echec}`, date: Date.now() });
    const dernier = messages.at(-1);
    const repli = !!dernier && dernier.role === 'user' && Date.now() - dernier.date < 10 * 60_000;
    const enCours = !!run || (!echec && repli);
    return { messages, enCours, activite: enCours && exporte ? extraireActivite(exporte, run?.debut) : undefined };
  }

  // ── exécution ──────────────────────────────────────────────────────────────

  function lancerRun(sid: string, texte: string) {
    derniersEchecs.delete(sid);
    const p = spawn('opencode', ['run', '--session', sid, '--agent', AGENT, '--model', MODELE, texte], {
      cwd: DIR,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env as Record<string, string>,
    });
    let err = '';
    p.stderr.on('data', (d: Buffer) => { err += d; });
    runsActifs.set(sid, { p, debut: Date.now() });

    // garde-fou par INACTIVITÉ (empreinte de session), plafond absolu
    const debutRun = Date.now();
    let derniereEmpreinte = '';
    let dernierChangement = Date.now();
    let raisonKill: string | null = null;
    const veille = setInterval(() => {
      if (!runsActifs.has(sid)) { clearInterval(veille); return; }
      if (Date.now() - debutRun > PLAFOND) {
        raisonKill = `La réponse a dépassé le plafond de ${Math.round(PLAFOND / 60000)} minutes et a été interrompue.`;
        p.kill('SIGKILL'); return;
      }
      const exporte = lireSession(sid);
      if (!exporte) return;
      const ms = exporte.messages;
      const empreinte = ms.length + ':' + ms.reduce((n, m) => n + (m.parts?.length ?? 0), 0)
        + ':' + ms.reduce((n, m) => n + (m.parts ?? []).reduce((k: number, q: any) => k + (q.text?.length ?? 0), 0), 0);
      if (empreinte !== derniereEmpreinte) { derniereEmpreinte = empreinte; dernierChangement = Date.now(); return; }
      if (Date.now() - dernierChangement > INACTIVITE) {
        raisonKill = `La réponse était bloquée (aucun progrès pendant ${Math.round(INACTIVITE / 60000)} minutes) et a été interrompue — réessayez.`;
        p.kill('SIGKILL');
      }
    }, 45_000);

    p.on('close', (code: number | null, signal: string | null) => {
      clearInterval(veille);
      runsActifs.delete(sid);
      if (signal === 'SIGKILL') {
        derniersEchecs.set(sid, raisonKill ?? 'La réponse a été interrompue.');
      } else if (code !== 0) {
        console.error(`chat-assistant: opencode run a échoué (code ${code}) :`, err.slice(0, 500));
        derniersEchecs.set(sid, "Le modèle n'a pas pu répondre — réessayez dans un instant.");
      }
    });
    p.on('error', (e: Error) => {
      clearInterval(veille);
      runsActifs.delete(sid);
      derniersEchecs.set(sid, `Assistant indisponible : ${e.message}`);
    });
  }

  async function envoyerMessage(
    userId: number, conversationId: number, texte: string, page: string | null
  ): Promise<{ accepte: true }> {
    const sid = await sessionDe(userId, conversationId, true);
    if (runsActifs.has(sid)) {
      throw Object.assign(new Error('Une réponse est déjà en cours pour cette conversation.'), { statut: 409 });
    }
    const contexte = page ? `[Page active de l'utilisateur·rice : ${page}]\n` : '';
    lancerRun(sid, contexte + texte);
    await pool.query(
      `update assistant_conversation set maj_le = now(),
         titre = coalesce(titre, left($2, 80)) where oc_session_id = $1`,
      [sid, texte.replace(/\s+/g, ' ').trim()]
    );
    return { accepte: true };
  }

  /** Relance la dernière question de la conversation (nouveau tour, même texte). */
  async function regenerer(userId: number, conversationId: number): Promise<{ accepte: true }> {
    const sid = await sessionDe(userId, conversationId, true);
    if (runsActifs.has(sid)) {
      throw Object.assign(new Error('Une réponse est déjà en cours pour cette conversation.'), { statut: 409 });
    }
    const exporte = lireSession(sid);
    const messages = versMessages(exporte);
    const dernierUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!dernierUser) throw Object.assign(new Error('Rien à régénérer.'), { statut: 400 });
    lancerRun(sid, `Régénère ta dernière réponse à cette question, avec des données fraîches :\n${dernierUser.texte}`);
    await pool.query(`update assistant_conversation set maj_le = now() where oc_session_id = $1`, [sid]);
    return { accepte: true };
  }

  // ── partage ────────────────────────────────────────────────────────────────

  async function listerUtilisateurs(userId: number): Promise<Utilisateur[]> {
    const { rows } = await pool.query(
      `select id, name as nom, initials as initiales from users where id <> $1 order by name`,
      [userId]
    );
    return rows;
  }

  async function partager(userId: number, conversationId: number, destinataireId: number): Promise<{ ok: true }> {
    await sessionDe(userId, conversationId, true); // propriétaire uniquement
    await pool.query(
      `insert into assistant_partage (conversation_id, destinataire_id)
       values ($1, $2) on conflict (conversation_id, destinataire_id) do nothing`,
      [conversationId, destinataireId]
    );
    return { ok: true };
  }

  return {
    listerConversations, creerConversation, listerMessages,
    envoyerMessage, regenerer, listerUtilisateurs, partager,
  };
}

export type ServiceAssistant = ReturnType<typeof creerServiceAssistant>;
