'use strict';

/**
 * One-off, idempotent seed: creates the single platform-level admin user
 * (company_id NULL, is_platform_admin true, role = "Platform Admin").
 * Safe to re-run — does nothing if a platform admin already exists.
 *
 * Usage:
 *   node scripts/seedPlatformAdmin.js <email> <password>
 *
 * Example:
 *   node scripts/seedPlatformAdmin.js platform-admin@gttdata.ai "Str0ng!Pass"
 */

require('dotenv').config();
const { User, Role } = require('../src/models');

async function main() {
  const [, , email, password] = process.argv;

  if (!email || !password) {
    console.error('Usage: node scripts/seedPlatformAdmin.js <email> <password>');
    process.exit(1);
  }

  const existingPlatformAdmin = await User.findOne({ where: { is_platform_admin: true } });
  if (existingPlatformAdmin) {
    console.log(`A platform admin already exists (id=${existingPlatformAdmin.id}, email=${existingPlatformAdmin.email}). Nothing to do.`);
    process.exit(0);
  }

  const platformAdminRole = await Role.findOne({ where: { role_name: 'Platform Admin' } });
  if (!platformAdminRole) {
    console.error('The "Platform Admin" role is not seeded. Run database/migrations/20260729_seed_platform_roles.sql first.');
    process.exit(1);
  }

  const existingUser = await User.findOne({ where: { email: email.toLowerCase() } });
  if (existingUser) {
    console.error(`A user with email "${email}" already exists (id=${existingUser.id}). Choose a different email.`);
    process.exit(1);
  }

  const admin = await User.create({
    email,
    password, // hashed automatically by the User model's beforeCreate hook
    role_id: platformAdminRole.id,
    company_id: null,
    is_platform_admin: true,
    status: 'active',
  });

  console.log(`Platform admin created: id=${admin.id}, email=${admin.email}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to seed platform admin:', err.message);
  process.exit(1);
});
