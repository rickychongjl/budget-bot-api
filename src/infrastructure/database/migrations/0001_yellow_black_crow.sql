CREATE TABLE "entitlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"source" text NOT NULL,
	"external_subscription_id" text,
	"status" text NOT NULL,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_tier_check" CHECK ("entitlement"."tier" in ('free', 'premium')),
	CONSTRAINT "entitlement_source_check" CHECK ("entitlement"."source" in ('telegram_stars', 'manual')),
	CONSTRAINT "entitlement_status_check" CHECK ("entitlement"."status" in ('active', 'expired', 'cancelled', 'refunded'))
);
--> statement-breakpoint
CREATE TABLE "usage_counter" (
	"user_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	CONSTRAINT "usage_counter_pkey" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counter" ADD CONSTRAINT "usage_counter_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_one_active" ON "entitlement" USING btree ("user_id") WHERE "entitlement"."status" = 'active';--> statement-breakpoint
CREATE INDEX "usage_counter_window" ON "usage_counter" USING btree ("user_id","admitted_at");--> statement-breakpoint
CREATE INDEX "usage_counter_daily" ON "usage_counter" USING btree ("user_id","local_date");