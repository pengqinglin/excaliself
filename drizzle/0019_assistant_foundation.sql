CREATE TABLE "assistant_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"drawingId" text NOT NULL,
	"nextMessageSequence" integer DEFAULT 1 NOT NULL,
	"nextEventSequence" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL,
	CONSTRAINT "assistant_conversations_sequences" CHECK ("assistant_conversations"."nextMessageSequence" > 0 and "assistant_conversations"."nextEventSequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "assistant_events" (
	"id" text PRIMARY KEY NOT NULL,
	"conversationId" text NOT NULL,
	"runId" text NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"requestId" text,
	"requestHash" text,
	"createdAt" timestamp NOT NULL,
	CONSTRAINT "assistant_events_content" CHECK ("assistant_events"."sequence" > 0 and jsonb_typeof("assistant_events"."data") = 'object' and "assistant_events"."kind" in ('message_created', 'run_created', 'run_claimed', 'run_controlled', 'run_acknowledged', 'run_reported') and (("assistant_events"."requestId" is null) = ("assistant_events"."requestHash" is null)))
);
--> statement-breakpoint
CREATE TABLE "assistant_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversationId" text NOT NULL,
	"runId" text NOT NULL,
	"sequence" integer NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"requestId" text NOT NULL,
	"requestHash" text NOT NULL,
	"createdAt" timestamp NOT NULL,
	CONSTRAINT "assistant_messages_content" CHECK ("assistant_messages"."sequence" > 0 and (
      ("assistant_messages"."source" = 'member' and "assistant_messages"."kind" = 'user' and "assistant_messages"."body" is not null and char_length("assistant_messages"."body") between 1 and 10000)
      or ("assistant_messages"."source" = 'worker' and "assistant_messages"."kind" = 'assistant' and "assistant_messages"."body" is not null and char_length("assistant_messages"."body") between 1 and 10000)
      or ("assistant_messages"."source" = 'member' and "assistant_messages"."kind" in ('pause', 'resume', 'cancel') and "assistant_messages"."body" is null)
    ))
);
--> statement-breakpoint
CREATE TABLE "assistant_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"conversationId" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"control" text DEFAULT 'running' NOT NULL,
	"controlVersion" integer DEFAULT 1 NOT NULL,
	"acknowledgedControlVersion" integer DEFAULT 0 NOT NULL,
	"firstInputSequence" integer NOT NULL,
	"lastInputSequence" integer NOT NULL,
	"receivedThroughSequence" integer DEFAULT 0 NOT NULL,
	"credentialKind" text,
	"credentialId" text,
	"workerId" text,
	"workerState" text,
	"leaseGeneration" integer DEFAULT 0 NOT NULL,
	"leaseExpiresAt" timestamp,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL,
	"finishedAt" timestamp,
	CONSTRAINT "assistant_runs_conversation_id" UNIQUE("conversationId","id"),
	CONSTRAINT "assistant_runs_state" CHECK ("assistant_runs"."status" in ('queued', 'running', 'awaiting_input', 'completed', 'failed', 'cancelled') and "assistant_runs"."control" in ('running', 'paused')),
	CONSTRAINT "assistant_runs_versions" CHECK ("assistant_runs"."controlVersion" > 0 and "assistant_runs"."acknowledgedControlVersion" between 0 and "assistant_runs"."controlVersion"),
	CONSTRAINT "assistant_runs_sequences" CHECK ("assistant_runs"."firstInputSequence" > 0 and "assistant_runs"."lastInputSequence" >= "assistant_runs"."firstInputSequence" and "assistant_runs"."receivedThroughSequence" >= 0),
	CONSTRAINT "assistant_runs_worker" CHECK ((
      ("assistant_runs"."workerId" is null and "assistant_runs"."credentialKind" is null and "assistant_runs"."credentialId" is null and "assistant_runs"."workerState" is null and "assistant_runs"."leaseGeneration" = 0 and "assistant_runs"."leaseExpiresAt" is null)
      or
      ("assistant_runs"."workerId" is not null and "assistant_runs"."credentialId" is not null and "assistant_runs"."credentialKind" is not null and "assistant_runs"."credentialKind" in ('access_token', 'oauth_grant') and "assistant_runs"."workerState" is not null and "assistant_runs"."workerState" in ('working', 'paused', 'awaiting_input') and "assistant_runs"."leaseGeneration" > 0)
    )),
	CONSTRAINT "assistant_runs_finished" CHECK (("assistant_runs"."finishedAt" is not null) = ("assistant_runs"."status" in ('completed', 'failed', 'cancelled')))
);
--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_drawingId_drawings_id_fk" FOREIGN KEY ("drawingId") REFERENCES "public"."drawings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_events" ADD CONSTRAINT "assistant_events_conversationId_assistant_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_events" ADD CONSTRAINT "assistant_events_conversationId_runId_assistant_runs_conversationId_id_fk" FOREIGN KEY ("conversationId","runId") REFERENCES "public"."assistant_runs"("conversationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversationId_assistant_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversationId_runId_assistant_runs_conversationId_id_fk" FOREIGN KEY ("conversationId","runId") REFERENCES "public"."assistant_runs"("conversationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_runs" ADD CONSTRAINT "assistant_runs_conversationId_assistant_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_conversations_member_drawing" ON "assistant_conversations" USING btree ("userId","drawingId");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_events_sequence" ON "assistant_events" USING btree ("conversationId","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_events_request" ON "assistant_events" USING btree ("conversationId","requestId");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_messages_sequence" ON "assistant_messages" USING btree ("conversationId","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_messages_request" ON "assistant_messages" USING btree ("conversationId","source","requestId");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_runs_one_active" ON "assistant_runs" USING btree ("conversationId") WHERE "assistant_runs"."status" in ('queued', 'running', 'awaiting_input');