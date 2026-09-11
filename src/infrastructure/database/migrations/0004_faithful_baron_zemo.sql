CREATE TABLE "daily_allowance_send" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"daily_target_minor_units" bigint NOT NULL,
	"budget_period_id" uuid NOT NULL,
	"delivery_status" text DEFAULT 'not_applicable' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_allowance_send_user_category_date_unique" UNIQUE("user_id","category_id","local_date"),
	CONSTRAINT "daily_allowance_send_status_check" CHECK ("daily_allowance_send"."delivery_status" in ('not_applicable', 'pending', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "reminder_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_allowance_send" ADD CONSTRAINT "daily_allowance_send_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_allowance_send" ADD CONSTRAINT "daily_allowance_send_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_allowance_send" ADD CONSTRAINT "daily_allowance_send_budget_period_id_budget_period_id_fk" FOREIGN KEY ("budget_period_id") REFERENCES "public"."budget_period"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_allowance_send_pending" ON "daily_allowance_send" USING btree ("delivery_status") WHERE "daily_allowance_send"."delivery_status" = 'pending';--> statement-breakpoint
CREATE INDEX "daily_allowance_send_user_date" ON "daily_allowance_send" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "category_reminder_enabled" ON "category" USING btree ("user_id") WHERE "category"."reminder_enabled";