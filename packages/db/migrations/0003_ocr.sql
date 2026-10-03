ALTER TABLE `books` ADD `ocr_state` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `books` ADD `ocr_progress` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pages` ADD `confidence` real;