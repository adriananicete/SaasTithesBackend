import { Category } from "../../models/Category.js";
import { isValidObjectId } from "../../utils/validate.js";
import { recordAudit } from "../../utils/recordAudit.js";

const getAllCategories = async (req, res, next) => {
  try {
    const getAllData = await Category.find();

    res.status(200).json(getAllData);
  } catch (error) {
    next(error);
  }
};

const createCategory = async (req, res, next) => {
  try {
    const { name, type, color } = req.body;
    const createdBy = req.user.id;

    if (!name || !type)
      return res.status(400).json({
        error: "Required All Fields!",
      });

    const newCategory = new Category({
      name,
      type,
      color,
      createdBy,
    });
    await newCategory.save();

    await recordAudit({
      req,
      action: "category.create",
      targetModel: "Category",
      targetId: newCategory._id,
      targetRef: newCategory.name,
      summary: `Created category ${newCategory.name} (${newCategory.type})`,
    });

    res.status(201).json({
      status: "Success",
      message: "Category created",
      data: {
        newCategory,
      },
    });
  } catch (error) {
    next(error);
  }
};

const updateCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ error: "Invalid Category ID" });
    const { name, type, color } = req.body;

    const updatedCategory = await Category.findByIdAndUpdate(
      id,
      {
        name,
        type,
        color,
      },
      { new: true },
    );
    if (!updatedCategory)
      return res.status(404).json({ error: "Category not found" });

    await recordAudit({
      req,
      action: "category.update",
      targetModel: "Category",
      targetId: updatedCategory._id,
      targetRef: updatedCategory.name,
      summary: `Updated category ${updatedCategory.name}`,
    });

    res.status(200).json({
      status: "Success",
      message: "Category updated",
      data: {
        updatedCategory,
      },
    });
  } catch (error) {
    next(error);
  }
};

const deleteCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ error: "Invalid Category ID" });

    const deletedCategory = await Category.findByIdAndDelete(id);
    if (!deletedCategory)
      return res.status(404).json({ error: "Category not found" });

    await recordAudit({
      req,
      action: "category.delete",
      targetModel: "Category",
      targetId: deletedCategory._id,
      targetRef: deletedCategory.name,
      summary: `Deleted category ${deletedCategory.name}`,
    });

    res.status(200).json({
      status: "Success",
      message: "Category Deleted!",
    });
  } catch (error) {
    next(error);
  }
};

export { getAllCategories, createCategory, updateCategory, deleteCategory };
