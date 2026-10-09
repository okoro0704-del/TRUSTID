CREATE TABLE "oauth_authorization_transactions" (
  "id" TEXT NOT NULL,
  "handle_hash" TEXT NOT NULL,
  "pre_auth_binding_hash" TEXT NOT NULL,
  "user_id" TEXT,
  "session_id" TEXT,
  "application_id" TEXT NOT NULL,
  "redirect_uri" TEXT NOT NULL,
  "scopes" TEXT NOT NULL,
  "state" TEXT,
  "code_challenge" TEXT NOT NULL,
  "code_challenge_method" TEXT NOT NULL,
  "nonce" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "denied_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "oauth_authorization_transactions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_authorization_transactions_handle_hash_key" ON "oauth_authorization_transactions"("handle_hash");
CREATE INDEX "oauth_authorization_transactions_session_id_status_idx" ON "oauth_authorization_transactions"("session_id", "status");
CREATE INDEX "oauth_authorization_transactions_expires_at_status_idx" ON "oauth_authorization_transactions"("expires_at", "status");
ALTER TABLE "oauth_authorization_transactions" ADD CONSTRAINT "oauth_authorization_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "oauth_authorization_transactions" ADD CONSTRAINT "oauth_authorization_transactions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "oauth_authorization_transactions" ADD CONSTRAINT "oauth_authorization_transactions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
