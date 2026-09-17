# Módulo `auth` (reservado — T2)

Login con número de documento, clave inicial = documento con cambio forzado,
sesiones con expiración/revocación, bloqueo tras 5 intentos, recuperación con
token de un solo uso, 3 roles (admin/empleado/caja). RLS por sede.

- Tablas (T2): `users`, `roles`, `user_roles`, `sessions`, `password_resets`.
- PRD: §5.1 AUTH-01…07, §9.1, §10 Auth, plan paso 1 (§12).
