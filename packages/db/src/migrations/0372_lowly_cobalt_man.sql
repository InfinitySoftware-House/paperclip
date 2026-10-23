CREATE TABLE "project_file_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_file_folders_sibling_name_uq" UNIQUE NULLS NOT DISTINCT("project_id","parent_id","name")
);
--> statement-breakpoint
ALTER TABLE "project_attachments" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "project_file_folders" ADD CONSTRAINT "project_file_folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_folders" ADD CONSTRAINT "project_file_folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_folders" ADD CONSTRAINT "project_file_folders_parent_id_project_file_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."project_file_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_file_folders_company_project_idx" ON "project_file_folders" USING btree ("company_id","project_id");--> statement-breakpoint
ALTER TABLE "project_attachments" ADD CONSTRAINT "project_attachments_folder_id_project_file_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."project_file_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_attachments_folder_idx" ON "project_attachments" USING btree ("folder_id");