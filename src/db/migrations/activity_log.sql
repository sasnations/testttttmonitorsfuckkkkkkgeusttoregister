-- Create activity log table
CREATE TABLE IF NOT EXISTS activity_log (
  id INT PRIMARY KEY AUTO_INCREMENT,
  activity_type VARCHAR(50) NOT NULL,
  user_id INT,
  details TEXT,
  ip_address VARCHAR(45),
  created_at DATETIME NOT NULL,
  INDEX (activity_type),
  INDEX (user_id),
  INDEX (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add entry to migrations tracking table if it exists
INSERT IGNORE INTO migrations (migration_name, applied_at) 
VALUES ('activity_log', NOW()); 