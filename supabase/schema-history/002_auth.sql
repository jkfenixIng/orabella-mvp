-- 002_auth.sql — T2 auth (AUTH-01…07).
--
-- Tablas: users, roles, user_roles, sessions, password_resets.
-- Decisión de credenciales (ver src/features/auth/README.md): la fuente de
-- verdad del login por documento es users.password_hash (scrypt, servidor).
-- Supabase Auth se aprovisiona en espejo solo cuando hay email real.
--
-- RLS: deny-by-default en las 5 tablas (sin políticas permisivas; solo
-- service_role en servidor). T3 (admin) agregará las políticas por sede/rol.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- users ---
CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- FK futura a public.sedes (la crea T3). Nullable en T2 a propósito:
  -- el MVP opera una sola sede y aún no existe el catálogo.
  sede_id uuid NULL,
  email text UNIQUE,
  phone text,
  id_type text NOT NULL CHECK (id_type IN ('CC', 'CE', 'PPT', 'PEP', 'otro')),
  id_number text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.users.sede_id IS
  'FK futura a sedes (T3 admin). Nullable en T2; T3 la vuelve NOT NULL con RLS por sede.';
COMMENT ON COLUMN public.users.email IS
  'Correo real del usuario. T2 lo exige en adminCreateUser (sin emails sintéticos); nullable en BD para usuarios legacy solo-documento.';
COMMENT ON COLUMN public.users.password_hash IS
  'Hash scrypt de la clave. Fuente de verdad del login por documento en el MVP (ver README del módulo auth).';
COMMENT ON COLUMN public.users.must_change_password IS
  'AUTH-01: true al crear (clave inicial = documento); bloquea todo hasta el cambio.';

CREATE INDEX idx_users_id_number ON public.users (id_number);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------- roles ---
CREATE TABLE public.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL CHECK (code IN ('admin', 'empleado', 'caja')),
  description text
);

INSERT INTO public.roles (code, description) VALUES
  ('admin', 'Administración total de su sede (AUTH-07).'),
  ('empleado', 'Operación asignada de su sede (AUTH-07).'),
  ('caja', 'Facturación y caja de su sede (AUTH-07).');

-- ----------------------------------------------------------- user_roles ---
CREATE TABLE public.user_roles (
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- ------------------------------------------------------------- sessions ---
CREATE TABLE public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  -- AUTH-03: timeout por inactividad (30 min, ver servicio auth).
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user_id ON public.sessions (user_id);
CREATE INDEX idx_sessions_token_hash ON public.sessions (token_hash);

-- ------------------------------------------------------- password_resets --
CREATE TABLE public.password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_password_resets_token_hash ON public.password_resets (token_hash);

-- ------------------------------------------------------------------ RLS ---
-- Deny-by-default: sin políticas, ningún rol (salvo service_role, que hace
-- bypass) puede leer/escribir. T3 agrega políticas por sede/rol.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_resets ENABLE ROW LEVEL SECURITY;
