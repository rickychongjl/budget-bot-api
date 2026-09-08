CREATE TABLE "parse_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"route" text NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"needed_clarification" boolean DEFAULT false NOT NULL,
	"was_corrected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parse_event_route_check" CHECK ("parse_event"."route" in ('command','mechanical','mapping','llm'))
);
--> statement-breakpoint
CREATE TABLE "merchant_category_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"normalized_merchant" text NOT NULL,
	"display_merchant" text NOT NULL,
	"category_id" uuid NOT NULL,
	"source" text NOT NULL,
	"times_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "merchant_category_mapping_user_merchant" UNIQUE("user_id","normalized_merchant"),
	CONSTRAINT "merchant_category_mapping_source_check" CHECK ("merchant_category_mapping"."source" in ('user_confirmed','user_corrected'))
);
--> statement-breakpoint
ALTER TABLE "parse_event" ADD CONSTRAINT "parse_event_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_category_mapping" ADD CONSTRAINT "merchant_category_mapping_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parse_event_created" ON "parse_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "merchant_category_mapping_user" ON "merchant_category_mapping" USING btree ("user_id");