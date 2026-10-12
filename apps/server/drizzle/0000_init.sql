CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"correlation_id" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"provider_tenant" text,
	"email_at_provider" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_subject" text NOT NULL,
	"account_email" text,
	"encrypted_refresh_token" text,
	"encrypted_access_token" text,
	"access_token_expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"sync_state" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"sync_in_progress" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"entity_id" text,
	"user_id" uuid,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_retry_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "meeting_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"transcript_id" uuid,
	"artifact_type" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"content" jsonb,
	"rendered_text" text,
	"provider" text,
	"model" text,
	"prompt_version" text,
	"usage" jsonb,
	"is_mock" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"participant_type" text,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"old_status" text,
	"new_status" text NOT NULL,
	"source" text NOT NULL,
	"reason_code" text,
	"safe_metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"calendar_connection_id" uuid,
	"provider_event_id" text,
	"provider_event_version" text,
	"title" text NOT NULL,
	"platform" text NOT NULL,
	"encrypted_meeting_url" text,
	"meeting_url_hash" text,
	"scheduled_start_at" timestamp with time zone NOT NULL,
	"scheduled_end_at" timestamp with time zone,
	"actual_start_at" timestamp with time zone,
	"actual_end_at" timestamp with time zone,
	"timezone_at_creation" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"substatus" text,
	"bot_provider" text,
	"provider_session_id" text,
	"registration_source" text,
	"registered_at" timestamp with time zone,
	"registered_by" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text,
	"mime_type" text,
	"file_size_bytes" bigint,
	"duration_seconds" integer,
	"checksum_sha256" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"provider_asset_id" text,
	"recorded_at" timestamp with time zone,
	"stored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"language" text,
	"provider" text,
	"model" text,
	"text" text,
	"segments" jsonb,
	"word_count" integer,
	"quality" text,
	"is_mock" boolean DEFAULT false NOT NULL,
	"raw_output" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"display_name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"auto_register" boolean,
	"recording_notice_acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"session_id" text,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_artifacts" ADD CONSTRAINT "meeting_artifacts_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_artifacts" ADD CONSTRAINT "meeting_artifacts_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_status_events" ADD CONSTRAINT "meeting_status_events_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_calendar_connection_id_calendar_connections_id_fk" FOREIGN KEY ("calendar_connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_events_time_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_subject_uq" ON "auth_identities" USING btree ("provider","provider_subject");--> statement-breakpoint
CREATE INDEX "auth_identities_user_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connections_account_uq" ON "calendar_connections" USING btree ("user_id","provider","account_subject");--> statement-breakpoint
CREATE INDEX "calendar_connections_status_idx" ON "calendar_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_uq" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_dispatch_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "jobs_entity_idx" ON "jobs" USING btree ("type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_artifacts_version_uq" ON "meeting_artifacts" USING btree ("meeting_id","artifact_type","version");--> statement-breakpoint
CREATE INDEX "meeting_artifacts_lookup_idx" ON "meeting_artifacts" USING btree ("meeting_id","artifact_type","version");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_participants_uq" ON "meeting_participants" USING btree ("meeting_id","source","source_key");--> statement-breakpoint
CREATE INDEX "meeting_status_events_meeting_idx" ON "meeting_status_events" USING btree ("meeting_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_calendar_event_uq" ON "meetings" USING btree ("calendar_connection_id","provider_event_id") WHERE "meetings"."provider_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_provider_session_uq" ON "meetings" USING btree ("bot_provider","provider_session_id") WHERE "meetings"."provider_session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_manual_dedupe_uq" ON "meetings" USING btree ("user_id","meeting_url_hash","scheduled_start_at") WHERE "meetings"."calendar_connection_id" IS NULL AND "meetings"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "meetings_user_start_idx" ON "meetings" USING btree ("user_id","scheduled_start_at");--> statement-breakpoint
CREATE INDEX "meetings_user_status_idx" ON "meetings" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "meetings_user_platform_idx" ON "meetings" USING btree ("user_id","platform");--> statement-breakpoint
CREATE INDEX "meetings_status_start_idx" ON "meetings" USING btree ("status","scheduled_start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_meeting_uq" ON "recordings" USING btree ("meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcripts_recording_uq" ON "transcripts" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "transcripts_meeting_idx" ON "transcripts" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uq" ON "webhook_events" USING btree ("provider","event_id");