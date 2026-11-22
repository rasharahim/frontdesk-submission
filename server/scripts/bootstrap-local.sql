\set ON_ERROR_STOP on

-- Run once against the local postgres database as a PostgreSQL administrator.
-- A failing preflight leaves existing databases and roles untouched.
SELECT 1 / (NOT EXISTS (
  SELECT FROM pg_database WHERE datname IN ('frontdesk_dev', 'frontdesk_test')
) AND NOT EXISTS (
  SELECT FROM pg_roles WHERE rolname IN (
    'frontdesk_runtime_access', 'frontdesk_dev_owner', 'frontdesk_dev_runtime',
    'frontdesk_test_owner', 'frontdesk_test_runtime'
  )
))::integer AS bootstrap_preflight;

CREATE ROLE frontdesk_runtime_access NOLOGIN;
CREATE ROLE frontdesk_dev_owner LOGIN;
CREATE ROLE frontdesk_dev_runtime LOGIN IN ROLE frontdesk_runtime_access;
CREATE ROLE frontdesk_test_owner LOGIN;
CREATE ROLE frontdesk_test_runtime LOGIN IN ROLE frontdesk_runtime_access;

SET password_encryption = 'scram-sha-256';
\password frontdesk_dev_owner
\password frontdesk_dev_runtime
\password frontdesk_test_owner
\password frontdesk_test_runtime

CREATE DATABASE frontdesk_dev OWNER frontdesk_dev_owner TEMPLATE template0;
CREATE DATABASE frontdesk_test OWNER frontdesk_test_owner TEMPLATE template0;

REVOKE ALL ON DATABASE frontdesk_dev FROM PUBLIC;
REVOKE ALL ON DATABASE frontdesk_test FROM PUBLIC;
GRANT CONNECT ON DATABASE frontdesk_dev TO frontdesk_dev_runtime;
GRANT CONNECT ON DATABASE frontdesk_test TO frontdesk_test_runtime;

\connect frontdesk_dev
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO frontdesk_runtime_access;

\connect frontdesk_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO frontdesk_runtime_access;
