#!/bin/bash
# BounceMan Database Backup Script
# Runs daily via cron

DB_PATH="/opt/bounceman/data/bounceman.db"
BACKUP_DIR="/opt/bounceman/backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Checkpoint WAL to ensure consistent backup
sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);"

# Create backup
cp "$DB_PATH" "$BACKUP_DIR/bounceman-$TIMESTAMP.db"

# Keep only last 14 days of backups
find "$BACKUP_DIR" -name "bounceman-*.db" -mtime +14 -delete

echo "[BACKUP] Created bounceman-$TIMESTAMP.db"
