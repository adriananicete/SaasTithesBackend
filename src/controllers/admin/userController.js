import bcrypt from "bcrypt";
import { User } from "../../models/User.js";
import cloudinary from "../../config/cloudinary.js";
import { recordAudit } from "../../utils/recordAudit.js";

const getAllUsers = async (req, res, next) => {
  try {
    const allUsers = await User.find()
      .sort({ createdAt: -1 })
      .select("-password");

    res.status(200).json(allUsers);
  } catch (error) {
    next(error);
  }
};

const getUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    const findUserById = await User.findById(id).select("-password");
    if (!findUserById)
      return res.status(404).json({ error: "User not found!" });

    res.status(200).json({
      status: "User found!",
      data: {
        findUserById,
      },
    });
  } catch (error) {
    next(error);
  }
};

const createUser = async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;

    // check if all fields have data
    if (!name || !email || !password || !role)
      return res.status(400).json({ error: "Required all fields!" });

    // check email if it already exists
    const userExist = await User.findOne({ email });
    if (userExist) return res.status(400).json({ error: "User already exist" });

    // hashing the password
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      name: name,
      email: email,
      password: hashedPassword,
      isActive: true,
      role: role,
    });

    await newUser.save();

    await recordAudit({
      req,
      action: "user.create",
      targetModel: "User",
      targetId: newUser._id,
      targetRef: newUser.email,
      summary: `Created user ${newUser.email} (${newUser.role})`,
    });

    const { password: _password, ...userData } = newUser.toObject();

    res.status(201).json({
      status: "Success",
      message: "New user created!",
      data: userData,
    });
  } catch (error) {
    next(error);
  }
};

const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { body } = req;

    const updatedUser = await User.findByIdAndUpdate(id, body, {
      new: true,
    }).select("-password");
    if (!updatedUser) return res.status(404).json({ error: "User not found!" });

    await recordAudit({
      req,
      action: "user.update",
      targetModel: "User",
      targetId: updatedUser._id,
      targetRef: updatedUser.email,
      summary: `Updated user ${updatedUser.email}`,
    });

    res.status(200).json({
      status: "Success",
      message: "User updated",
      data: {
        updatedUser,
      },
    });
  } catch (error) {
    next(error);
  }
};

const isActiveUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    const findUserByIdAndUpdate = await User.findByIdAndUpdate(
      id,
      { $set: { isActive: false } },
      { new: true },
    ).select("-password");
    if (!findUserByIdAndUpdate)
      return res.status(404).json({ error: "User not found!" });

    await recordAudit({
      req,
      action: "user.deactivate",
      targetModel: "User",
      targetId: findUserByIdAndUpdate._id,
      targetRef: findUserByIdAndUpdate.email,
      summary: `Deactivated user ${findUserByIdAndUpdate.email}`,
    });

    res.status(200).json({
      status: "Success",
      message: "User Deactivated",
      data: {
        findUserByIdAndUpdate,
      },
    });
  } catch (error) {
    next(error);
  }
};

const deleteUser = async (req, res, next) => {
    try {
        const { id } = req.params;

        const deletedUser  = await User.findByIdAndDelete(id);
        if(!deletedUser ) return res.status(404).json({ error: "User not found!" });

        await recordAudit({
            req,
            action: 'user.delete',
            targetModel: 'User',
            targetId: deletedUser._id,
            targetRef: deletedUser.email,
            summary: `Deleted user ${deletedUser.email}`,
        });

        res.status(200).json({
            status: 'Success',
            message: 'User Deleted'
        })
    } catch (error) {
        next(error);
    }
};

// Admin sets/replaces another user's avatar. Same Cloudinary handling as the
// self-service route, but targets :id and audits with the admin as actor.
const setUserAvatar = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "User not found!" });

    if (user.avatarPublicId) {
      try { await cloudinary.uploader.destroy(user.avatarPublicId); } catch (e) { /* non-fatal */ }
    }

    user.avatarUrl = req.file.path;
    user.avatarPublicId = req.file.filename;
    await user.save();

    await recordAudit({
      req,
      action: "user.update_avatar",
      targetModel: "User",
      targetId: user._id,
      targetRef: user.email,
      summary: `Updated profile photo for ${user.email}`,
    });

    const { password: _pw, ...data } = user.toObject();
    res.status(200).json({ status: "Success", message: "Profile photo updated", data });
  } catch (error) {
    next(error);
  }
};

const removeUserAvatar = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "User not found!" });

    if (user.avatarPublicId) {
      try { await cloudinary.uploader.destroy(user.avatarPublicId); } catch (e) { /* non-fatal */ }
    }

    user.avatarUrl = null;
    user.avatarPublicId = null;
    await user.save();

    await recordAudit({
      req,
      action: "user.remove_avatar",
      targetModel: "User",
      targetId: user._id,
      targetRef: user.email,
      summary: `Removed profile photo for ${user.email}`,
    });

    const { password: _pw, ...data } = user.toObject();
    res.status(200).json({ status: "Success", message: "Profile photo removed", data });
  } catch (error) {
    next(error);
  }
};

export {
  getAllUsers,
  getUser,
  createUser,
  updateUser,
  isActiveUser,
  deleteUser,
  setUserAvatar,
  removeUserAvatar,
};
