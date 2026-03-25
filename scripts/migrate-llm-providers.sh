#!/bin/bash

# LLM Provider Migration Script
# This script helps migrate your database to support the new LLM provider system

set -e

echo "🚀 LLM Provider Migration Script"
echo "================================="
echo ""

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "❌ ERROR: DATABASE_URL environment variable is not set"
    echo "Please set it in your .env file or export it:"
    echo "  export DATABASE_URL='postgresql://...'"
    exit 1
fi

echo "✅ DATABASE_URL found"
echo ""

# Confirm before proceeding
echo "This script will:"
echo "  1. Update the llm_settings table constraint"
echo "  2. Convert localhost Ollama entries to 'llama-local'"
echo "  3. Ensure a default provider exists"
echo ""
read -p "Do you want to proceed? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Migration cancelled"
    exit 0
fi

echo ""
echo "📦 Running migration..."
echo ""

# Run the migration SQL
psql "$DATABASE_URL" -f apps/api/src/db/migrate-llm-providers.sql

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Migration completed successfully!"
    echo ""
    echo "Next steps:"
    echo "  1. Update your .env file (see .env.example)"
    echo "  2. Rebuild: npm run build"
    echo "  3. Restart: npm run dev"
    echo ""
    echo "📚 For more details, see:"
    echo "  - Docs/Migration_Guide.md"
    echo "  - Docs/LLM_Provider_Refactor.md"
else
    echo ""
    echo "❌ Migration failed!"
    echo "Please check the error messages above and try again."
    exit 1
fi
