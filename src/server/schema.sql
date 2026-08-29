-- website-chat-assistant — tables côté app hôte (à sourcer dans son schéma).
-- users(id, name, initials) est la table du kit auth de l'hôte.

create table if not exists assistant_conversation (
  id serial primary key,
  user_id integer not null,
  oc_session_id text not null unique,
  titre text,
  page text,
  cree_le timestamptz not null default now(),
  maj_le timestamptz not null default now()
);
create index if not exists idx_assistant_conv_user on assistant_conversation(user_id, maj_le desc);

-- Partage en lecture seule d'une conversation à un·e autre utilisateur·rice.
create table if not exists assistant_partage (
  id serial primary key,
  conversation_id integer not null references assistant_conversation(id) on delete cascade,
  destinataire_id integer not null,
  cree_le timestamptz not null default now(),
  unique (conversation_id, destinataire_id)
);
