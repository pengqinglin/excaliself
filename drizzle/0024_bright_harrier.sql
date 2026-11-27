CREATE TABLE "assistant_drawing_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"conversationId" text NOT NULL,
	"tokenHash" text NOT NULL,
	"createdAt" timestamp NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"revokedAt" timestamp,
	"lastSeenAt" timestamp,
	"clientName" text,
	"control" text DEFAULT 'running' NOT NULL,
	CONSTRAINT "assistant_drawing_grants_tokenHash_unique" UNIQUE("tokenHash"),
	CONSTRAINT "assistant_drawing_grants_valid" CHECK ("assistant_drawing_grants"."expiresAt" > "assistant_drawing_grants"."createdAt" and "assistant_drawing_grants"."control" in ('running', 'paused'))
);
--> statement-breakpoint
ALTER TABLE "assistant_runs" DROP CONSTRAINT "assistant_runs_state";--> statement-breakpoint
ALTER TABLE "assistant_runs" DROP CONSTRAINT "assistant_runs_worker";--> statement-breakpoint
ALTER TABLE "assistant_runs" ADD COLUMN "source" text DEFAULT 'connector' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_drawing_grants" ADD CONSTRAINT "assistant_drawing_grants_conversationId_assistant_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_drawing_grants_active" ON "assistant_drawing_grants" USING btree ("conversationId") WHERE "assistant_drawing_grants"."revokedAt" is null;--> statement-breakpoint
ALTER TABLE "assistant_runs" ADD CONSTRAINT "assistant_runs_state" CHECK ("assistant_runs"."status" in ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled') and "assistant_runs"."control" in ('running', 'paused') and "assistant_runs"."source" in ('connector', 'invitation'));--> statement-breakpoint
ALTER TABLE "assistant_runs" ADD CONSTRAINT "assistant_runs_worker" CHECK ((
      ("assistant_runs"."workerId" is null and "assistant_runs"."credentialKind" is null and "assistant_runs"."credentialId" is null and "assistant_runs"."workerState" is null and "assistant_runs"."leaseGeneration" = 0 and "assistant_runs"."leaseExpiresAt" is null)
      or
      ("assistant_runs"."workerId" is not null and "assistant_runs"."credentialId" is not null and "assistant_runs"."credentialKind" is not null and "assistant_runs"."credentialKind" in ('access_token', 'oauth_grant', 'drawing_grant') and "assistant_runs"."workerState" is not null and "assistant_runs"."workerState" in ('working', 'paused', 'awaiting_input') and "assistant_runs"."leaseGeneration" > 0)
    ));