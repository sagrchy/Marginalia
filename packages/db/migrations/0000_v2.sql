CREATE TABLE `books` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_id` integer NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`slug` text NOT NULL,
	`file_hash` text NOT NULL,
	`file_name` text DEFAULT '' NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`password` text,
	`page_count` integer DEFAULT 0 NOT NULL,
	`page_labels` text,
	`label_ranges` text,
	`chapters` text DEFAULT '[]' NOT NULL,
	`chapters_source` text DEFAULT 'blocks' NOT NULL,
	`index_state` text DEFAULT 'queued' NOT NULL,
	`index_progress` real DEFAULT 0 NOT NULL,
	`index_error` text,
	`empty_pages` integer DEFAULT 0 NOT NULL,
	`garbled_pages` integer DEFAULT 0 NOT NULL,
	`spreads` integer DEFAULT false NOT NULL,
	`last_page` integer DEFAULT 0 NOT NULL,
	`last_opened_at` integer,
	`deleted_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `books_hash_idx` ON `books` (`file_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `books_slug_idx` ON `books` (`slug`);--> statement-breakpoint
CREATE TABLE `highlights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`session_id` integer,
	`color` text DEFAULT 'yellow' NOT NULL,
	`page_index` integer NOT NULL,
	`parts` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `highlights_book_idx` ON `highlights` (`book_id`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`source` text DEFAULT 'ai' NOT NULL,
	`subject_id` integer,
	`book_id` integer,
	`session_id` integer,
	`message_id` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`page_index` integer,
	`selection` text,
	`activity` text DEFAULT '[]' NOT NULL,
	`model` text,
	`status` text DEFAULT 'ok' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_session_idx` ON `messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`session_id` integer,
	`page_index` integer,
	`body` text NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notes_book_idx` ON `notes` (`book_id`);--> statement-breakpoint
CREATE TABLE `pages` (
	`book_id` integer NOT NULL,
	`page_index` integer NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`quality` text DEFAULT 'ok' NOT NULL,
	`char_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`book_id`, `page_index`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reading_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`session_id` integer,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`page_index` integer NOT NULL,
	`dwell_ms` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `reading_book_idx` ON `reading_events` (`book_id`);--> statement-breakpoint
CREATE INDEX `reading_session_idx` ON `reading_events` (`session_id`);--> statement-breakpoint
CREATE INDEX `reading_ts_idx` ON `reading_events` (`ts`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`name` text NOT NULL,
	`goal` text,
	`type` text DEFAULT 'first_read' NOT NULL,
	`timebox_min` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`claude_session_id` text NOT NULL,
	`claude_started` integer DEFAULT false NOT NULL,
	`folder` text NOT NULL,
	`summary` text,
	`legacy` integer DEFAULT false NOT NULL,
	`started_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`ended_at` integer,
	`last_active_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_book_idx` ON `sessions` (`book_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subjects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`tutor_style` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subjects_slug_unique` ON `subjects` (`slug`);--> statement-breakpoint
CREATE TABLE `usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`session_id` integer,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`error` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `usage_ts_idx` ON `usage` (`ts`);