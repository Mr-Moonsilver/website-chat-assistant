import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MessageCircle, Plus, Send, X, ChevronLeft, Maximize2, Minimize2,
  Copy, Check, RefreshCw, ListTree, Download, Share2,
} from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * website-chat-assistant — widget de chat (coin bas-gauche).
 *
 * Barre d'actions sous chaque réponse (patron OpenWebUI : visible sur la
 * dernière, révélée au survol sur les précédentes) : copier, régénérer,
 * sources (les appels d'outils du tour), télécharger (.md), partager la
 * conversation à un·e autre utilisateur·rice de l'app.
 *
 * L'app hôte fournit : `apiBase` (ex. '/api/assistant' — via son client API),
 * `api` (get/post JSON authentifiés) et `page` (le libellé de la page
 * active, joint à chaque message pour le contexte de l'agent).
 */

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, data: unknown): Promise<T>;
}

interface Conversation {
  id: number; titre: string | null; page: string | null; majLe: string;
  partagePar: string | null; lectureSeule: boolean;
}
interface SourceMessage { nom: string; detail: string }
interface MessageChat { role: 'user' | 'assistant'; texte: string; date: number; sources?: SourceMessage[] }
interface OutilActivite { nom: string; detail: string; statut: string }
interface Activite { depuis: number | null; tokens: { entree: number; sortie: number; estime: boolean }; outils: OutilActivite[]; apercu: string | null }
interface EtatConversation { messages: MessageChat[]; enCours: boolean; activite?: Activite }
interface Utilisateur { id: number; nom: string; initiales: string }

function MarkdownAssistant({ texte }: { texte: string }) {
  const html = DOMPurify.sanitize(marked.parse(texte, { async: false }) as string);
  return <div className="chat-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function BandeauActivite({ activite }: { activite: Activite | undefined }) {
  const [, tic] = useState(0);
  // Compteur INTERPOLÉ : sqlite ne reçoit les tokens qu'aux jalons d'étape,
  // mais le modèle génère entre-temps. Entre deux jalons on avance le
  // compteur au rythme typique de génération (~22 tok/s), en PAUSE quand un
  // outil tourne (le modèle ne génère pas), et on se recale sur chaque
  // valeur réelle du serveur. Affiché avec « ≈ » tant qu'on interpole.
  const afficheRef = useRef(0);
  const serveurRef = useRef(0);
  useEffect(() => {
    const t = setInterval(() => {
      const outilActif = (activite?.outils ?? []).some((o) => o.statut === 'running' || o.statut === 'pending');
      if (!outilActif && afficheRef.current < serveurRef.current + 350) {
        afficheRef.current += 22; // rythme de croisière qwen sur 4×3090
      }
      tic((n) => n + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [activite]);
  const brut = activite?.tokens?.sortie ?? 0;
  if (brut > serveurRef.current) serveurRef.current = brut;
  if (serveurRef.current > afficheRef.current) afficheRef.current = serveurRef.current;
  const affiche = Math.round(afficheRef.current);
  const estime = afficheRef.current > serveurRef.current || (activite?.tokens?.estime ?? false);

  const ecoule = activite?.depuis ? Math.max(0, Math.floor((Date.now() - activite.depuis) / 1000)) : null;
  const mmss = ecoule != null ? `${Math.floor(ecoule / 60)}:${String(ecoule % 60).padStart(2, '0')}` : null;
  const outils = activite?.outils ?? [];
  const visibles = outils.slice(-4);
  return (
    <div className="chat-activite">
      <div className="chat-activite__entete">
        <span className="chat-activite__pts" aria-hidden><span /><span /><span /></span>
        <span>Réponse en cours…</span>
        <span className="chat-activite__meta tabular-nums">
          {mmss && <>⏱ {mmss}</>}
          {affiche > 0 && (
            <> · {estime ? '≈ ' : ''}{affiche.toLocaleString('fr-CH')} tokens générés</>
          )}
          {outils.length > 4 && <> · {outils.length} outils</>}
        </span>
      </div>
      {visibles.map((o, i) => (
        <div key={`${i}-${o.nom}-${o.detail}`}
             className={`chat-activite__outil${o.statut === 'running' || o.statut === 'pending' ? ' chat-activite__outil--actif' : ''}`}>
          <span className="chat-activite__puce" aria-hidden />
          <strong>{o.nom}</strong>
          {o.detail && <span className="chat-activite__detail">{o.detail}</span>}
        </div>
      ))}
      {activite?.apercu && <div className="chat-activite__apercu">{activite.apercu}</div>}
    </div>
  );
}

/** Barre d'actions d'une réponse — patron OpenWebUI (dernière visible, autres au survol). */
function ActionsReponse({ m, derniere, lectureSeule, onRegenerer, onPartager }: {
  m: MessageChat; derniere: boolean; lectureSeule: boolean;
  onRegenerer: () => void; onPartager: () => void;
}) {
  const [copie, setCopie] = useState(false);
  const [voirSources, setVoirSources] = useState(false);

  const copier = () => {
    navigator.clipboard?.writeText(m.texte).then(() => {
      setCopie(true); setTimeout(() => setCopie(false), 1500);
    });
  };
  const telecharger = () => {
    const blob = new Blob([m.texte], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `assistant-${new Date(m.date || Date.now()).toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className={`chat-actions${derniere ? ' chat-actions--visible' : ''}`}>
        <button type="button" className="chat-actions__btn" aria-label="Copier" title="Copier" onClick={copier}>
          {copie ? <Check size={13} /> : <Copy size={13} />}
        </button>
        {derniere && !lectureSeule && (
          <button type="button" className="chat-actions__btn" aria-label="Régénérer" title="Régénérer la réponse" onClick={onRegenerer}>
            <RefreshCw size={13} />
          </button>
        )}
        {m.sources && m.sources.length > 0 && (
          <button type="button" className={`chat-actions__btn${voirSources ? ' chat-actions__btn--actif' : ''}`}
                  aria-label="Sources" title={`Sources (${m.sources.length} consultations)`}
                  onClick={() => setVoirSources((v) => !v)}>
            <ListTree size={13} />
          </button>
        )}
        <button type="button" className="chat-actions__btn" aria-label="Télécharger" title="Télécharger (.md)" onClick={telecharger}>
          <Download size={13} />
        </button>
        {!lectureSeule && (
          <button type="button" className="chat-actions__btn" aria-label="Partager" title="Partager la conversation" onClick={onPartager}>
            <Share2 size={13} />
          </button>
        )}
      </div>
      {voirSources && m.sources && (
        <div className="chat-sources">
          <div className="chat-sources__titre">Sources — consultations effectuées pour cette réponse</div>
          {m.sources.map((s, i) => (
            <div key={i} className="chat-sources__ligne">
              <strong>{s.nom}</strong>
              {s.detail && <span>{s.detail}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export interface AssistantChatProps {
  page: string;
  pageLisible?: string;
  api: ApiClient;
  apiBase?: string;      // défaut '/assistant' (relatif au client API de l'hôte)
  titre?: string;        // défaut 'Assistant · données'
}

export function AssistantChat({ page, pageLisible, api, apiBase = '/assistant', titre = 'Assistant · données' }: AssistantChatProps) {
  const [ouvert, setOuvert] = useState(false);
  const [grand, setGrand] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<MessageChat[]>([]);
  const [activite, setActivite] = useState<Activite | undefined>(undefined);
  const [saisie, setSaisie] = useState('');
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [partageOuvert, setPartageOuvert] = useState(false);
  const [utilisateurs, setUtilisateurs] = useState<Utilisateur[]>([]);
  const [partageFait, setPartageFait] = useState<string | null>(null);
  const bas = useRef<HTMLDivElement>(null);

  const libelle = pageLisible ?? page;

  useEffect(() => {
    if (ouvert) api.get<Conversation[]>(`${apiBase}/conversations`).then(setConversations).catch(() => {});
  }, [ouvert, api, apiBase]);

  useEffect(() => { bas.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, envoiEnCours]);

  const scruterRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const arreterScrutation = useCallback(() => {
    if (scruterRef.current) { clearInterval(scruterRef.current); scruterRef.current = null; }
  }, []);
  useEffect(() => arreterScrutation, [arreterScrutation]);

  const rafraichir = useCallback((c: Conversation, demarrer = false) => {
    api.get<EtatConversation>(`${apiBase}/conversations/${c.id}/messages`)
      .then((r: EtatConversation) => {
        const norme = (t: string) => t.replace(/\s+/g, ' ').trim();
        setMessages((locaux) => {
          const dernierLocal = locaux.at(-1);
          if (dernierLocal?.role === 'user' && !r.messages.some((m) => m.role === 'user' && norme(m.texte) === norme(dernierLocal.texte))) {
            return [...r.messages, dernierLocal];
          }
          return r.messages;
        });
        setActivite(r.activite);
        if (r.enCours) {
          setEnvoiEnCours(true);
          if (!scruterRef.current) scruterRef.current = setInterval(() => rafraichir(c), 2500);
        } else {
          setEnvoiEnCours(false);
          setActivite(undefined);
          arreterScrutation();
        }
      })
      .catch(() => { if (demarrer) setErreur("Impossible de charger l'historique."); });
  }, [api, apiBase, arreterScrutation]);

  const ouvrirConversation = useCallback((c: Conversation) => {
    setActive(c); setMessages([]); setErreur(null); setPartageOuvert(false); setPartageFait(null);
    arreterScrutation(); setEnvoiEnCours(false);
    rafraichir(c, true);
  }, [rafraichir, arreterScrutation]);

  const nouvelle = useCallback(() => {
    setErreur(null);
    api.post<Conversation>(`${apiBase}/conversations`, { page: libelle })
      .then((c: Conversation) => { setConversations((l) => [c, ...l]); setActive(c); setMessages([]); })
      .catch(() => setErreur("L'assistant est indisponible."));
  }, [api, apiBase, libelle]);

  const envoyer = useCallback(() => {
    const texte = saisie.trim();
    if (!texte || !active || envoiEnCours || active.lectureSeule) return;
    setSaisie(''); setErreur(null);
    setMessages((ms) => [...ms, { role: 'user', texte, date: Date.now() }]);
    setEnvoiEnCours(true);
    api.post<{ accepte: boolean }>(`${apiBase}/conversations/${active.id}/messages`, { texte, page: libelle })
      .then(() => { if (!scruterRef.current) scruterRef.current = setInterval(() => rafraichir(active), 2500); })
      .catch((e: any) => { setErreur(e?.message ?? "L'assistant n'a pas pu répondre."); setEnvoiEnCours(false); });
  }, [saisie, active, envoiEnCours, libelle, api, apiBase, rafraichir]);

  const regenerer = useCallback(() => {
    if (!active || envoiEnCours) return;
    setErreur(null); setEnvoiEnCours(true);
    api.post<{ accepte: boolean }>(`${apiBase}/conversations/${active.id}/regenerer`, {})
      .then(() => { if (!scruterRef.current) scruterRef.current = setInterval(() => rafraichir(active), 2500); })
      .catch((e: any) => { setErreur(e?.message ?? 'Régénération impossible.'); setEnvoiEnCours(false); });
  }, [active, envoiEnCours, api, apiBase, rafraichir]);

  const ouvrirPartage = useCallback(() => {
    setPartageOuvert(true); setPartageFait(null);
    api.get<Utilisateur[]>(`${apiBase}/utilisateurs`).then(setUtilisateurs).catch(() => setUtilisateurs([]));
  }, [api, apiBase]);

  const partagerA = useCallback((u: Utilisateur) => {
    if (!active) return;
    api.post<{ ok: boolean }>(`${apiBase}/conversations/${active.id}/partager`, { destinataireId: u.id })
      .then(() => setPartageFait(u.nom))
      .catch(() => setErreur('Partage impossible.'));
  }, [active, api, apiBase]);

  const derniereReponse = [...messages].reverse().find((m) => m.role === 'assistant');

  return (
    <>
      <button type="button" aria-label="Assistant de données" className="chat-bouton"
              data-ouvert={ouvert || undefined} onClick={() => setOuvert((o) => !o)}>
        {ouvert ? <X size={20} /> : <MessageCircle size={20} />}
      </button>

      {ouvert && (
        <div className="chat-fenetre" data-grand={grand || undefined}>
          <div className="chat-entete">
            {active && (
              <button type="button" className="btn btn-icon" aria-label="Retour aux conversations" onClick={() => setActive(null)}>
                <ChevronLeft size={16} />
              </button>
            )}
            <strong style={{ flex: 1 }}>{titre}</strong>
            <button type="button" className="btn btn-icon" aria-label={grand ? 'Réduire la fenêtre' : 'Agrandir la fenêtre'}
                    title={grand ? 'Réduire' : 'Agrandir'} onClick={() => setGrand((g) => !g)}>
              {grand ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <span className="badge badge-plain badge-sm">{libelle}</span>
            {!active && (
              <button type="button" className="btn btn-sm btn-accent" onClick={nouvelle}>
                <Plus size={14} /> Nouvelle
              </button>
            )}
          </div>

          {!active ? (
            <div className="chat-liste">
              {conversations.length === 0 && (
                <div className="text-ink-3 p-16" style={{ textAlign: 'center' }}>
                  Posez une question sur les données de la page en cours —<br />« Nouvelle » pour commencer.
                </div>
              )}
              {conversations.map((c) => (
                <div key={`${c.id}-${c.partagePar ?? ''}`} className="chat-liste__item" onClick={() => ouvrirConversation(c)}>
                  <div className="chat-liste__titre">{c.titre ?? 'Nouvelle conversation'}</div>
                  <div className="text-ink-3" style={{ fontSize: 11 }}>
                    {c.partagePar && <span className="badge badge-plain badge-sm" style={{ marginRight: 6 }}>partagée par {c.partagePar}</span>}
                    {c.page ? `${c.page} · ` : ''}{new Date(c.majLe).toLocaleDateString('fr-CH')}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="chat-corps">
              {messages.length === 0 && !envoiEnCours && (
                <div className="text-ink-3" style={{ fontSize: 12 }}>
                  Je réponds avec les données de l'app — en priorité celles de la page « {libelle} ».
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`chat-bulle chat-bulle--${m.role}`}>
                  {m.role === 'assistant'
                    ? (
                      <>
                        <MarkdownAssistant texte={m.texte} />
                        <ActionsReponse m={m} derniere={m === derniereReponse} lectureSeule={active.lectureSeule}
                                        onRegenerer={regenerer} onPartager={ouvrirPartage} />
                      </>
                    )
                    : <span style={{ whiteSpace: 'pre-wrap' }}>{m.texte}</span>}
                </div>
              ))}
              {envoiEnCours && <BandeauActivite activite={activite} />}
              {erreur && <div className="text-err" style={{ fontSize: 12 }}>{erreur}</div>}
              {partageOuvert && (
                <div className="chat-partage">
                  <div className="chat-partage__entete">
                    <strong>Partager la conversation</strong>
                    <button type="button" className="btn btn-icon" aria-label="Fermer" onClick={() => setPartageOuvert(false)}><X size={13} /></button>
                  </div>
                  {partageFait && <div className="text-ink-2" style={{ fontSize: 12 }}>✓ Partagée avec {partageFait} (lecture seule).</div>}
                  {utilisateurs.map((u) => (
                    <button key={u.id} type="button" className="chat-partage__user" onClick={() => partagerA(u)}>
                      <span className="chat-partage__initiales">{u.initiales}</span>{u.nom}
                    </button>
                  ))}
                  {utilisateurs.length === 0 && <div className="text-ink-3" style={{ fontSize: 12 }}>Aucun·e autre utilisateur·rice.</div>}
                </div>
              )}
              <div ref={bas} />
            </div>
          )}

          {active && !active.lectureSeule && (
            <div className="chat-saisie">
              <textarea className="form-input" rows={1} placeholder="Votre question…"
                        value={saisie} onChange={(e) => setSaisie(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); envoyer(); } }}
                        disabled={envoiEnCours} />
              <button type="button" className="btn btn-accent" onClick={envoyer}
                      disabled={envoiEnCours || !saisie.trim()} aria-label="Envoyer">
                <Send size={15} />
              </button>
            </div>
          )}
          {active?.lectureSeule && (
            <div className="chat-saisie text-ink-3" style={{ fontSize: 12 }}>
              Conversation partagée par {active.partagePar} — lecture seule.
            </div>
          )}
        </div>
      )}
    </>
  );
}
