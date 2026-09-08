CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_user_normalized_name_unique" UNIQUE("user_id","normalized_name")
);
--> statement-breakpoint
CREATE TABLE "budget" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid,
	"cap_minor_units" bigint NOT NULL,
	"currency_code" char(3) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_cap_positive" CHECK ("budget"."cap_minor_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "budget_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"cap_minor_units" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_period_budget_key_unique" UNIQUE("budget_id","period_key"),
	CONSTRAINT "budget_period_range" CHECK ("budget_period"."period_start" <= "budget_period"."period_end"),
	CONSTRAINT "budget_period_cap_positive" CHECK ("budget_period"."cap_minor_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid,
	"budget_period_id" uuid,
	"direction" text NOT NULL,
	"amount_minor_units" bigint NOT NULL,
	"currency_code" char(3) NOT NULL,
	"occurred_on" date NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"merchant_display" text,
	"normalized_merchant" text,
	"note" text,
	"raw_text" text,
	"parse_route" text NOT NULL,
	"parse_confidence" numeric(4, 3),
	"status" text DEFAULT 'confirmed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "transaction_direction_check" CHECK ("transaction"."direction" in ('expense', 'income', 'refund')),
	CONSTRAINT "transaction_amount_positive" CHECK ("transaction"."amount_minor_units" > 0),
	CONSTRAINT "transaction_parse_route_check" CHECK ("transaction"."parse_route" in ('command', 'mechanical', 'mapping', 'llm')),
	CONSTRAINT "transaction_status_check" CHECK ("transaction"."status" in ('confirmed', 'pending', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget" ADD CONSTRAINT "budget_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_period" ADD CONSTRAINT "budget_period_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_period" ADD CONSTRAINT "budget_period_budget_id_budget_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budget"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_budget_period_id_budget_period_id_fk" FOREIGN KEY ("budget_period_id") REFERENCES "public"."budget_period"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "category_user_active" ON "category" USING btree ("user_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_one_active_per_category" ON "budget" USING btree ("user_id","category_id") WHERE "budget"."is_active";--> statement-breakpoint
CREATE INDEX "budget_user" ON "budget" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "budget_period_lookup" ON "budget_period" USING btree ("user_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "transaction_user_date" ON "transaction" USING btree ("user_id","occurred_on" DESC NULLS LAST) WHERE "transaction"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX "transaction_period" ON "transaction" USING btree ("budget_period_id") WHERE "transaction"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX "transaction_user_created" ON "transaction" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE "transaction"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX "transaction_category_date" ON "transaction" USING btree ("category_id","occurred_on") WHERE "transaction"."status" = 'confirmed';