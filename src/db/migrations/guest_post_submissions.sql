-- Create guest post submissions table
CREATE TABLE IF NOT EXISTS guest_post_submissions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  website_url VARCHAR(512) NOT NULL,
  niche VARCHAR(255) NOT NULL,
  message TEXT,
  status ENUM('pending', 'approved', 'rejected', 'completed') DEFAULT 'pending',
  admin_notes TEXT,
  created_at DATETIME NOT NULL,
  updated_at DATETIME,
  INDEX (status),
  INDEX (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add entry to migrations tracking table if it exists
INSERT IGNORE INTO migrations (migration_name, applied_at) 
VALUES ('guest_post_submissions', NOW()); 