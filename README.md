# website-chat-assistant

Widget de chat + pont serveur vers un agent **opencode** local, extrait de
l'app Budget de L'Éveil. Conversations par utilisateur·rice, bandeau
d'activité en direct (outils, tokens, chrono, aperçu), rendu markdown,
actions par réponse (copier · régénérer · sources · télécharger · partager
en lecture seule), fenêtre agrandissable.

## Architecture (leçons durement acquises, ne pas « simplifier »)

- `opencode serve` ne sert QU'À créer les sessions (métadonnée fiable). Son
  registre de modèles se perd par intermittence : **l'exécution passe par le
  CLI** (`opencode run --session`), en processus suivi, garde-fou par
  inactivité (empreinte de session), jamais de borne de durée fixe.
- La lecture se fait **directement dans l'état sqlite d'opencode** (WAL,
  lecture seule) : `opencode export` tronque pendant les runs, et le serveur
  ne voit pas les écritures du CLI.
- Le CLI enrobe le message argv de guillemets littéraux : le service les
  retire (sinon la question s'affiche en double face à la bulle optimiste).
- Les tokens n'arrivent dans l'état qu'aux jalons d'étape : le client
  interpole entre les jalons (~22 tok/s, pause quand un outil tourne) et se
  recale sur chaque valeur réelle — affiché « ≈ » tant qu'il interpole.

## Intégration (patron submodule des kits L'Éveil)

1. `git submodule add https://github.com/Mr-Moonsilver/website-chat-assistant.git lib/website-chat-assistant`
2. tsconfig `paths` + alias esbuild : `"website-chat-assistant/*": ["./lib/website-chat-assistant/src/*"]`
3. Schéma : sourcer `src/server/schema.sql` dans le schéma de l'app.
4. Serveur :
   ```ts
   import { creerServiceAssistant } from 'website-chat-assistant/server/service.js';
   import { creerRouteurAssistant } from 'website-chat-assistant/server/routes.js';
   const service = creerServiceAssistant({ pool, agent: 'donnees', modele: 'halcyon/qwen3.8-27b' });
   app.use('/api/assistant', creerRouteurAssistant({ service, requireAuth }));
   ```
5. Client :
   ```tsx
   import { AssistantChat } from 'website-chat-assistant/client/AssistantChat';
   <AssistantChat page={currentPage} pageLisible={LIBELLES[currentPage]} api={api} />
   ```
6. CSS : copier `src/client/chat-assistant.css` vers les statiques au build et
   le lier dans l'index.html (il consomme les tokens du design-kit hôte).
7. Conteneur : opencode installé + `opencode serve` sur 127.0.0.1 (création de
   sessions), agent défini dans l'opencode.json GLOBAL de l'image (config
   projet ignorée sans dépôt git), sessions créées avec `location.directory`.

L'app hôte reste propriétaire de : l'agent opencode (prompt, skills,
permissions), le jeton d'accès interne à son API de données, la table users.
