-- 006_installation_owner.sql
-- Exactly one installation owner may hold superadmin. This migration deliberately
-- does not infer an owner or change any existing role assignment.
BEGIN;

CREATE OR REPLACE FUNCTION public.assert_installation_owner_operator()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog'
AS $$
BEGIN
  IF session_user = 'orabella_app' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'INSTALLATION_OWNER_OPERATOR_REQUIRED';
  END IF;
END;
$$;

CREATE TABLE public.installation_owner (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_user_id uuid NOT NULL UNIQUE REFERENCES public.users(id)
);

CREATE OR REPLACE FUNCTION public.assert_installation_owner_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  IF current_setting('orabella.owner_break_glass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' AND current_setting('orabella.owner_provision', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSTALLATION_OWNER_IMMUTABLE';
END;
$$;

CREATE TRIGGER trg_installation_owner_immutable
BEFORE INSERT OR UPDATE OR DELETE ON public.installation_owner
FOR EACH ROW EXECUTE FUNCTION public.assert_installation_owner_immutable();

CREATE OR REPLACE FUNCTION public.assert_superadmin_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_superadmin_id uuid;
  v_owner_id uuid;
  v_old_is_superadmin boolean;
  v_new_is_superadmin boolean;
BEGIN
  SELECT id INTO v_superadmin_id FROM public.roles WHERE code = 'superadmin';
  IF v_superadmin_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SUPERADMIN_ROLE_NOT_FOUND';
  END IF;

  v_old_is_superadmin := TG_OP <> 'INSERT' AND OLD.role_id = v_superadmin_id;
  v_new_is_superadmin := TG_OP <> 'DELETE' AND NEW.role_id = v_superadmin_id;
  IF NOT v_old_is_superadmin AND NOT v_new_is_superadmin THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT owner_user_id INTO v_owner_id FROM public.installation_owner WHERE singleton;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OWNER_NOT_PROVISIONED';
  END IF;

  IF current_setting('orabella.owner_provision', true) = 'on'
     OR current_setting('orabella.owner_break_glass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_new_is_superadmin AND NEW.user_id <> v_owner_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SUPERADMIN_OWNER_ONLY';
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSTALLATION_OWNER_ROLE_IMMUTABLE';
END;
$$;

CREATE TRIGGER trg_superadmin_owner
BEFORE INSERT OR UPDATE OR DELETE ON public.user_roles
FOR EACH ROW EXECUTE FUNCTION public.assert_superadmin_owner();

CREATE OR REPLACE FUNCTION public.provision_installation_owner(p_owner_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_superadmin_id uuid;
BEGIN
  PERFORM public.assert_installation_owner_operator();
  PERFORM pg_advisory_xact_lock(pg_catalog.hashtext('orabella.installation_owner'));
  IF EXISTS (SELECT 1 FROM public.installation_owner WHERE singleton) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSTALLATION_OWNER_ALREADY_PROVISIONED';
  END IF;
  PERFORM 1 FROM public.users WHERE id = p_owner_user_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.users WHERE id = p_owner_user_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSTALLATION_OWNER_INACTIVE';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'USER_NOT_FOUND';
  END IF;
  SELECT id INTO v_superadmin_id FROM public.roles WHERE code = 'superadmin';
  IF v_superadmin_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SUPERADMIN_ROLE_NOT_FOUND';
  END IF;

  PERFORM set_config('orabella.owner_provision', 'on', true);
  INSERT INTO public.installation_owner (owner_user_id) VALUES (p_owner_user_id);
  INSERT INTO public.user_roles (user_id, role_id) VALUES (p_owner_user_id, v_superadmin_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.break_glass_transfer_installation_owner(p_new_owner_user_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_old_owner_id uuid;
  v_superadmin_id uuid;
BEGIN
  PERFORM public.assert_installation_owner_operator();
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSTALLATION_OWNER_REASON_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock(pg_catalog.hashtext('orabella.installation_owner'));
  SELECT owner_user_id INTO v_old_owner_id FROM public.installation_owner WHERE singleton FOR UPDATE;
  IF v_old_owner_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OWNER_NOT_PROVISIONED';
  END IF;
  PERFORM 1 FROM public.users WHERE id = p_new_owner_user_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.users WHERE id = p_new_owner_user_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSTALLATION_OWNER_INACTIVE';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'USER_NOT_FOUND';
  END IF;
  SELECT id INTO v_superadmin_id FROM public.roles WHERE code = 'superadmin';
  IF v_superadmin_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SUPERADMIN_ROLE_NOT_FOUND';
  END IF;

  PERFORM set_config('orabella.owner_break_glass', 'on', true);
  DELETE FROM public.user_roles WHERE user_id = v_old_owner_id AND role_id = v_superadmin_id;
  UPDATE public.installation_owner SET owner_user_id = p_new_owner_user_id WHERE singleton;
  INSERT INTO public.user_roles (user_id, role_id)
  SELECT p_new_owner_user_id, v_superadmin_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_new_owner_user_id AND role_id = v_superadmin_id
  );
  INSERT INTO public.audit_logs (action, entity, entity_id, metadata)
  VALUES (
    'installation_owner_break_glass_transfer',
    'installation_owner',
    'singleton',
    jsonb_build_object(
      'old', v_old_owner_id,
      'new', p_new_owner_user_id,
      'reason', btrim(p_reason),
      'operator', session_user
    )
  );
END;
$$;

COMMENT ON TABLE public.installation_owner IS
  '006: singleton installation owner. Empty until an operator explicitly provisions a real active users.id; never inferred or backfilled.';
COMMENT ON FUNCTION public.provision_installation_owner(uuid) IS
  '006: one-time operator-only provisioning of the active installation owner and its sole superadmin role.';
COMMENT ON FUNCTION public.break_glass_transfer_installation_owner(uuid, text) IS
  '006: audited operator-only recovery/transfer. Requires a nonblank reason and writes audit_logs metadata old/new/reason/operator.';

REVOKE ALL ON TABLE public.installation_owner FROM PUBLIC;
REVOKE ALL ON TABLE public.installation_owner FROM anon;
REVOKE ALL ON TABLE public.installation_owner FROM authenticated;
REVOKE ALL ON FUNCTION public.assert_installation_owner_operator() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_installation_owner_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_superadmin_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.provision_installation_owner(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.provision_installation_owner(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.provision_installation_owner(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.break_glass_transfer_installation_owner(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.break_glass_transfer_installation_owner(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.break_glass_transfer_installation_owner(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.provision_installation_owner(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.break_glass_transfer_installation_owner(uuid, text) TO service_role;

COMMIT;
