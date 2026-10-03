CREATE TABLE `book_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`page_index` integer NOT NULL,
	`section` text,
	`text` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `book_items_book_idx` ON `book_items` (`book_id`,`kind`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`session_id` integer,
	`front` text NOT NULL,
	`back` text NOT NULL,
	`page_index` integer,
	`source` text DEFAULT 'ai' NOT NULL,
	`due` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`interval_days` real DEFAULT 0 NOT NULL,
	`ease` real DEFAULT 2.5 NOT NULL,
	`reps` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`last_reviewed_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cards_book_due_idx` ON `cards` (`book_id`,`due`);--> statement-breakpoint
CREATE TABLE `passages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`page_index` integer NOT NULL,
	`end_page` integer NOT NULL,
	`section` text,
	`text` text NOT NULL,
	`embedding` blob,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passages_book_idx` ON `passages` (`book_id`,`page_index`);--> statement-breakpoint
CREATE TABLE `summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`title` text NOT NULL,
	`page_from` integer NOT NULL,
	`page_to` integer NOT NULL,
	`text` text NOT NULL,
	`model` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `summaries_range_idx` ON `summaries` (`book_id`,`page_from`,`page_to`);--> statement-breakpoint
ALTER TABLE `books` ADD `embed_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `books` ADD `embed_progress` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `books` ADD `brief` text;--> statement-breakpoint
ALTER TABLE `notes` ADD `title` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `scope_from` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `scope_to` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `scope_label` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `ai` text DEFAULT 'tutor' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `ephemeral` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `plan` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `next` text;--> statement-breakpoint
CREATE VIRTUAL TABLE `passages_fts` USING fts5(`text`, `section`, content='passages', content_rowid='id', tokenize='porter unicode61');--> statement-breakpoint
CREATE TRIGGER `passages_ai` AFTER INSERT ON `passages` BEGIN
  INSERT INTO passages_fts(rowid, text, section) VALUES (new.id, new.text, coalesce(new.section, ''));
END;--> statement-breakpoint
CREATE TRIGGER `passages_ad` AFTER DELETE ON `passages` BEGIN
  INSERT INTO passages_fts(passages_fts, rowid, text, section) VALUES ('delete', old.id, old.text, coalesce(old.section, ''));
END;--> statement-breakpoint
CREATE TRIGGER `passages_au` AFTER UPDATE OF `text`, `section` ON `passages` BEGIN
  INSERT INTO passages_fts(passages_fts, rowid, text, section) VALUES ('delete', old.id, old.text, coalesce(old.section, ''));
  INSERT INTO passages_fts(rowid, text, section) VALUES (new.id, new.text, coalesce(new.section, ''));
END;
