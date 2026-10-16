-- =====================================================================
-- 智能客服 Agent —— 云端数据库建表脚本（Supabase / PostgreSQL）
-- 在 Supabase 控制台 → SQL Editor 里整段粘贴执行即可
-- =====================================================================

-- 1. 会话表：一次对话 = 一条 session
create table if not exists sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       text        not null default 'guest',
  channel       text        not null default 'web',
  status        text        not null default 'open',      -- open | transferred | closed
  transferred   boolean     not null default false,
  message_count integer     not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_sessions_created on sessions (created_at desc);

-- 2. 消息表：多轮对话的每一轮，带意图与置信度（后台分析的基础）
create table if not exists messages (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  role       text  not null,                              -- user | agent | system
  content    text  not null,
  intent     text,                                        -- refund | order_query | tech_support | ...
  confidence numeric(4,3),                                -- 0.000 ~ 1.000
  source     text,                                        -- rule | faq | llm | human | slot | fallback
  latency_ms integer,
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_session on messages (session_id, created_at asc);
create index if not exists idx_messages_intent  on messages (intent);

-- 3. 工单表：转人工时自动生成
create table if not exists tickets (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  reason     text  not null,
  category   text  not null default 'other',
  priority   text  not null default 'normal',             -- low | normal | high | urgent
  status     text  not null default 'pending',            -- pending | processing | resolved
  summary    text,
  created_at timestamptz not null default now()
);
create index if not exists idx_tickets_created on tickets (created_at desc);

-- 4. 满意度评价表
create table if not exists feedbacks (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  score      integer not null check (score between 1 and 5),
  comment    text,
  created_at timestamptz not null default now()
);
create index if not exists idx_feedbacks_created on feedbacks (created_at desc);

-- =====================================================================
-- Row Level Security：演示阶段开放匿名读写（anon key）
-- 生产环境务必改成「仅本人可读写自己的会话」
-- =====================================================================
alter table sessions  enable row level security;
alter table messages  enable row level security;
alter table tickets   enable row level security;
alter table feedbacks enable row level security;

do $$
declare t text;
begin
  foreach t in array array['sessions','messages','tickets','feedbacks'] loop
    execute format('drop policy if exists anon_all on %I', t);
    execute format('create policy anon_all on %I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;
