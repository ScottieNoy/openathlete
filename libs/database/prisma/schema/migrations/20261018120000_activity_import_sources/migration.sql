-- Additive only: existing activities and their external IDs are preserved.
CREATE TABLE "activity_import_source" (
    "activity_import_source_id" SERIAL NOT NULL,
    "athlete_id" INTEGER NOT NULL,
    "provider" "connector_provider" NOT NULL,
    "external_id" TEXT NOT NULL,
    "event_activity_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "activity_import_source_pkey" PRIMARY KEY ("activity_import_source_id")
);

CREATE UNIQUE INDEX "activity_import_source_athlete_id_provider_external_id_key"
    ON "activity_import_source"("athlete_id", "provider", "external_id");
CREATE INDEX "activity_import_source_event_activity_id_idx"
    ON "activity_import_source"("event_activity_id");
ALTER TABLE "activity_import_source" ADD CONSTRAINT "activity_import_source_event_activity_id_fkey"
    FOREIGN KEY ("event_activity_id") REFERENCES "event_activity"("event_activity_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
