ALTER TABLE "activity_segment"
ADD COLUMN "source_provider" "connector_provider",
ADD COLUMN "source_external_id" TEXT,
ADD COLUMN "source_data" JSONB;

CREATE UNIQUE INDEX "activity_segment_provider_identity_key"
ON "activity_segment" ("event_activity_id", "source_provider", "source_external_id");
