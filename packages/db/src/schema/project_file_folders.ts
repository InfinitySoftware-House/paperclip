import { pgTable, uuid, text, timestamp, index, unique, type AnyPgColumn } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/** Folders that organize a project's reference files into a tree. */
export const projectFileFolders = pgTable(
  "project_file_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => projectFileFolders.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectIdx: index("project_file_folders_company_project_idx").on(table.companyId, table.projectId),
    siblingNameUq: unique("project_file_folders_sibling_name_uq")
      .on(table.projectId, table.parentId, table.name)
      .nullsNotDistinct(),
  }),
);
