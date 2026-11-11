-- Isolated research owner; never initialize this schema in the source environment.
CREATE SCHEMA IF NOT EXISTS research;
CREATE TABLE IF NOT EXISTS research.runs(id uuid PRIMARY KEY,owner text NOT NULL,name text NOT NULL,config jsonb NOT NULL,state text NOT NULL DEFAULT 'DRAFT',created_at timestamptz NOT NULL DEFAULT now(),heartbeat timestamptz,cancel_requested boolean NOT NULL DEFAULT false,manifest jsonb NOT NULL DEFAULT '{}',error text);
CREATE TABLE IF NOT EXISTS research.repetitions(id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES research.runs,ordinal int NOT NULL,state text NOT NULL,started_at bigint,ended_at bigint,tc bigint,summary jsonb,UNIQUE(run_id,ordinal));
CREATE TABLE IF NOT EXISTS research.events(id bigserial PRIMARY KEY,run_id uuid NOT NULL REFERENCES research.runs,repetition_id uuid REFERENCES research.repetitions,kind text NOT NULL,at bigint NOT NULL,data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS research.samples(id bigserial PRIMARY KEY,run_id uuid NOT NULL REFERENCES research.runs,repetition_id uuid NOT NULL REFERENCES research.repetitions,sequence int NOT NULL,data jsonb NOT NULL,UNIQUE(repetition_id,sequence));
CREATE TABLE IF NOT EXISTS research.licenses(id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES research.runs,product_id uuid NOT NULL,expires_at bigint NOT NULL,max_devices int NOT NULL,status int NOT NULL,version int NOT NULL DEFAULT 1,generation int NOT NULL DEFAULT 1,block_number bigint,block_hash text,observed_at bigint);
CREATE TABLE IF NOT EXISTS research.devices(license_id uuid NOT NULL REFERENCES research.licenses,id text NOT NULL,public_key text NOT NULL,generation int NOT NULL DEFAULT 1,PRIMARY KEY(license_id,id));
CREATE TABLE IF NOT EXISTS research.commands(id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES research.runs,license_id uuid NOT NULL,kind text NOT NULL,payload_hash text NOT NULL,tx_hash text,raw_tx text,state text NOT NULL,receipt jsonb,UNIQUE(license_id,kind));
CREATE TABLE IF NOT EXISTS research.settings(key text PRIMARY KEY,value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS research.artifacts(run_id uuid PRIMARY KEY REFERENCES research.runs,data jsonb NOT NULL,checksum text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS samples_run ON research.samples(run_id,id);
CREATE INDEX IF NOT EXISTS events_run ON research.events(run_id,id);
-- Versioned authority: never rewrite legacy experimental evidence.
CREATE TABLE IF NOT EXISTS research.v2_licenses(id uuid PRIMARY KEY,data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS research.v2_devices(license_id uuid NOT NULL REFERENCES research.v2_licenses,generation int NOT NULL,device text NOT NULL,PRIMARY KEY(license_id,generation,device));
CREATE TABLE IF NOT EXISTS research.v2_requests(key text PRIMARY KEY,payload text NOT NULL,version int NOT NULL);
CREATE TABLE IF NOT EXISTS research.v2_products(id uuid PRIMARY KEY,issuer text NOT NULL);
CREATE TABLE IF NOT EXISTS research.v2_commands(id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES research.runs,contract text NOT NULL,actor text NOT NULL,operation text NOT NULL,payload jsonb NOT NULL,state text NOT NULL,hash text,receipt jsonb);
CREATE TABLE IF NOT EXISTS research.http_benchmarks(id uuid PRIMARY KEY,owner text NOT NULL,state text NOT NULL,manifest jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS research.http_benchmark_events(id bigserial PRIMARY KEY,session_id uuid NOT NULL REFERENCES research.http_benchmarks,kind text NOT NULL,data jsonb NOT NULL,at timestamptz NOT NULL DEFAULT now());
