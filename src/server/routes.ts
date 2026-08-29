import { Router, type Request, type Response, type NextFunction } from 'express';
import type { ServiceAssistant } from './service.js';

/**
 * website-chat-assistant — routeur Express.
 *
 * L'app hôte fournit son middleware d'authentification (qui pose `req.user`)
 * et, si elle expose un accès interne machine (jeton lecture seule), celui-ci
 * est explicitement refusé ici : l'assistant ne se parle pas à lui-même.
 *
 *   GET  /conversations                    les miennes + celles partagées avec moi
 *   POST /conversations {page}             nouvelle conversation
 *   GET  /conversations/:id/messages       {messages, enCours, activite}
 *   POST /conversations/:id/messages       {texte, page} → {accepte}
 *   POST /conversations/:id/regenerer      relance la dernière question
 *   POST /conversations/:id/partager       {destinataireId}
 *   GET  /utilisateurs                     destinataires possibles du partage
 */
export interface DepsRouteur {
  service: ServiceAssistant;
  requireAuth: (req: any, res: Response, next: NextFunction) => any;
}

export function creerRouteurAssistant({ service, requireAuth }: DepsRouteur): Router {
  const router = Router();
  router.use(requireAuth);
  router.use((req: any, res: Response, next: NextFunction) => {
    if (req.user && req.user.id < 0) return res.status(403).json({ error: 'Réservé aux utilisateur·rices.' });
    next();
  });
  router.param('id', (_req: Request, res: Response, next: NextFunction, val: string) => {
    const n = Number(val);
    if (!Number.isInteger(n) || n <= 0 || n > 2_000_000_000) return res.status(400).json({ error: 'Identifiant invalide.' });
    next();
  });

  const attraper = (fn: (req: any, res: Response) => Promise<void>) =>
    async (req: any, res: Response) => {
      try { await fn(req, res); } catch (err: any) {
        if (err?.statut) return res.status(err.statut).json({ error: err.message });
        console.error(`chat-assistant ${req.method} ${req.path} :`, err);
        res.status(502).json({ error: "L'assistant n'a pas pu traiter la demande." });
      }
    };

  router.get('/conversations', attraper(async (req, res) => {
    res.json(await service.listerConversations(req.user.id));
  }));

  router.post('/conversations', attraper(async (req, res) => {
    const page = typeof req.body?.page === 'string' ? req.body.page.slice(0, 60) : null;
    res.json(await service.creerConversation(req.user.id, page));
  }));

  router.get('/conversations/:id/messages', attraper(async (req, res) => {
    res.json(await service.listerMessages(req.user.id, Number(req.params.id)));
  }));

  router.post('/conversations/:id/messages', attraper(async (req, res) => {
    const texte = typeof req.body?.texte === 'string' ? req.body.texte.trim() : '';
    if (!texte) return void res.status(400).json({ error: 'Message vide.' });
    if (texte.length > 4000) return void res.status(400).json({ error: 'Message trop long (4000 caractères max).' });
    const page = typeof req.body?.page === 'string' ? req.body.page.slice(0, 60) : null;
    res.json(await service.envoyerMessage(req.user.id, Number(req.params.id), texte, page));
  }));

  router.post('/conversations/:id/regenerer', attraper(async (req, res) => {
    res.json(await service.regenerer(req.user.id, Number(req.params.id)));
  }));

  router.post('/conversations/:id/partager', attraper(async (req, res) => {
    const destinataireId = Number(req.body?.destinataireId);
    if (!Number.isInteger(destinataireId) || destinataireId <= 0) {
      return void res.status(400).json({ error: 'Destinataire invalide.' });
    }
    res.json(await service.partager(req.user.id, Number(req.params.id), destinataireId));
  }));

  router.get('/utilisateurs', attraper(async (req, res) => {
    res.json(await service.listerUtilisateurs(req.user.id));
  }));

  return router;
}
