ALTER TABLE "drawings" ADD COLUMN "serverManagedAt" timestamp;--> statement-breakpoint
ALTER TABLE "drawings" ADD COLUMN "sceneRevision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_scene_revision" CHECK ("drawings"."sceneRevision" >= 0);