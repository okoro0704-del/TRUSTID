ALTER TABLE "oauth_authorization_transactions" ADD COLUMN "authorization_code_id" TEXT;
CREATE UNIQUE INDEX "oauth_authorization_transactions_authorization_code_id_key" ON "oauth_authorization_transactions"("authorization_code_id");
ALTER TABLE "oauth_authorization_transactions" ADD CONSTRAINT "oauth_authorization_transactions_authorization_code_id_fkey" FOREIGN KEY ("authorization_code_id") REFERENCES "oauth_authorization_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
