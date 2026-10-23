import { pgTable, uuid, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { assets } from "./assets.js";
import { projectFileFolders } from "./project_file_folders.js";

export const projectAttachments = pgTable(
  "project_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    // Null keeps the file at the project's root folder.
    folderId: uuid("folder_id").references(() => projectFileFolders.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("project_attachments_company_project_idx").on(table.companyId, table.projectId),
    assetUq: uniqueIndex("project_attachments_asset_uq").on(table.assetId),
    folderIdx: index("project_attachments_folder_idx").on(table.folderId),
  }),
);
