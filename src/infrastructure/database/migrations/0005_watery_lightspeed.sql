CREATE TABLE "inbound_update" (
	"channel" text NOT NULL,
	"update_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_update_pkey" PRIMARY KEY("channel","update_id")
);
--> statement-breakpoint
CREATE TABLE "pending_prompt" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"parse_event_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_prompt_kind_check" CHECK ("pending_prompt"."kind" in ('confirm', 'clarify'))
);
--> statement-breakpoint
ALTER TABLE "pending_prompt" ADD CONSTRAINT "pending_prompt_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_prompt" ADD CONSTRAINT "pending_prompt_parse_event_id_parse_event_id_fk" FOREIGN KEY ("parse_event_id") REFERENCES "public"."parse_event"("id") ON DELETE set null ON UPDATE no action;