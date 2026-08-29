import mongoose from 'mongoose'
import bcrypt from 'bcrypt'
import { User } from '../models/User.js'

const seed = async () => {
    const password = process.env.SEED_ADMIN_PASSWORD
    if (!password) {
        console.error('SEED_ADMIN_PASSWORD is not set. Add it to your .env before seeding.')
        process.exit(1)
    }

    const name = process.env.SEED_ADMIN_NAME || 'Adrian'
    const email = process.env.SEED_ADMIN_EMAIL || 'adrian@joscm.com'

    await mongoose.connect(process.env.CONNECTION_STRING)

    const hashedPassword = await bcrypt.hash(password, 10)

    await User.create({
        name,
        email,
        password: hashedPassword,
        role: 'admin',
        isActive: true
    })

    console.log('Seeded successfully')
    process.exit()
}

seed()
