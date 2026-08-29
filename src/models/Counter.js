import mongoose from "mongoose";

// Per-church atomic sequence for RF-#### and PCF-#### numbering. Read and
// incremented in one findOneAndUpdate($inc) so two concurrent creates can
// never land on the same number — the previous "read the newest doc and add
// one" approach was racy even with a single church.
const counterSchema = new mongoose.Schema({
    church: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Church',
        required: true,
    },
    // 'rfNo' | 'pcfNo'
    key: {
        type: String,
        required: true,
    },
    seq: {
        type: Number,
        default: 0,
    },
}, { timestamps: true });

// One counter per church per key; also the lookup path for nextNumber().
counterSchema.index({ church: 1, key: 1 }, { unique: true });

export const Counter = mongoose.model('Counter', counterSchema);
