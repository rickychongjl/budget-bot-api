CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timezone" text NOT NULL,
	"currency_code" char(3) DEFAULT 'AUD' NOT NULL,
	"period_anchor_date" date,
	"reminder_local_time" time DEFAULT '07:00' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "app_user_status_check" CHECK ("app_user"."status" in ('active', 'suspended', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "channel_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"username" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_connection_channel_external_id_unique" UNIQUE("channel","external_id"),
	CONSTRAINT "channel_connection_channel_check" CHECK ("channel_connection"."channel" in ('telegram'))
);
--> statement-breakpoint
ALTER TABLE "channel_connection" ADD CONSTRAINT "channel_connection_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_connection_user" ON "channel_connection" USING btree ("user_id");