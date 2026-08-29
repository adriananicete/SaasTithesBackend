import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { connectDB } from '../config/db.js';
import { User } from '../models/User.js';
import { ROLES } from '../constants/roles.js';

// Creates the system owner. Superadmin belongs to no church (church stays
// null) and can only reach /api/superadmin/*.
//
// Run:  node --env-file=.env src/scripts/seedSuperadmin.js
// Idempotent — re-running reports the existing account instead of failing.
const seedSuperadmin = async () => {
    const password = process.env.SEED_SUPERADMIN_PASSWORD;
    const email = process.env.SEED_SUPERADMIN_EMAIL;

    if (!password || !email) {
        console.error(
            'SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD must both be set in your .env before seeding.'
        );
        process.exit(1);
    }

    const name = process.env.SEED_SUPERADMIN_NAME || 'System Owner';

    await connectDB();

    const existing = await User.findOne({ email, role: ROLES.SUPERADMIN });
    if (existing) {
        console.log(`Superadmin already exists: ${existing.email} (created ${existing.createdAt.toISOString()})`);
        await mongoose.disconnect();
        process.exit(0);
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const superadmin = await User.create({
        name,
        email,
        password: hashedPassword,
        role: ROLES.SUPERADMIN,
        church: null,
        isActive: true,
    });

    console.log(`Superadmin created: ${superadmin.email}`);
    await mongoose.disconnect();
    process.exit(0);
};

seedSuperadmin();
