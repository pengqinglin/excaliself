CREATE TABLE "assistant_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"conversationId" text NOT NULL,
	"runId" text NOT NULL,
	"requestId" text NOT NULL,
	"requestHash" text NOT NULL,
	"summary" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"beforeSettings" jsonb,
	"afterSettings" jsonb,
	"sceneRevision" integer NOT NULL,
	"createdAt" timestamp NOT NULL,
	CONSTRAINT "assistant_operations_revision" CHECK ("assistant_operations"."sceneRevision" > 0 and char_length("assistant_operations"."summary") between 1 and 200 and jsonb_typeof("assistant_operations"."before") = 'array' and jsonb_typeof("assistant_operations"."after") = 'array')
);
--> statement-breakpoint
ALTER TABLE "assistant_events" DROP CONSTRAINT "assistant_events_content";--> statement-breakpoint
ALTER TABLE "assistant_operations" ADD CONSTRAINT "assistant_operations_conversationId_assistant_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_operations" ADD CONSTRAINT "assistant_operations_conversationId_runId_assistant_runs_conversationId_id_fk" FOREIGN KEY ("conversationId","runId") REFERENCES "public"."assistant_runs"("conversationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_operations_request" ON "assistant_operations" USING btree ("conversationId","requestId");--> statement-breakpoint
ALTER TABLE "assistant_events" ADD CONSTRAINT "assistant_events_content" CHECK ("assistant_events"."sequence" > 0 and jsonb_typeof("assistant_events"."data") = 'object' and "assistant_events"."kind" in ('message_created', 'run_created', 'run_claimed', 'run_controlled', 'run_acknowledged', 'run_reported', 'scene_committed') and (("assistant_events"."requestId" is null) = ("assistant_events"."requestHash" is null)));