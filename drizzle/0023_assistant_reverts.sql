ALTER TABLE "assistant_operations" ADD COLUMN "undoOf" text;--> statement-breakpoint
ALTER TABLE "assistant_operations" ADD COLUMN "revertedAt" timestamp;--> statement-breakpoint
ALTER TABLE "assistant_operations" ADD CONSTRAINT "assistant_operations_undoOf_assistant_operations_id_fk" FOREIGN KEY ("undoOf") REFERENCES "public"."assistant_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_operations_undo" ON "assistant_operations" USING btree ("undoOf");