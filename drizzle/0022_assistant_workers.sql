CREATE TABLE "assistant_workers" (
	"userId" text NOT NULL,
	"credentialKind" text NOT NULL,
	"credentialId" text NOT NULL,
	"workerId" text NOT NULL,
	"name" text NOT NULL,
	"lastSeenAt" timestamp NOT NULL,
	CONSTRAINT "assistant_workers_userId_credentialKind_credentialId_workerId_pk" PRIMARY KEY("userId","credentialKind","credentialId","workerId"),
	CONSTRAINT "assistant_workers_identity" CHECK ("assistant_workers"."credentialKind" in ('access_token', 'oauth_grant') and char_length("assistant_workers"."workerId") between 1 and 128 and char_length("assistant_workers"."name") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "assistant_workers" ADD CONSTRAINT "assistant_workers_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;