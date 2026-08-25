import { Request, Response } from "express";
import * as productRepo from "../repositories/product.repository";

export async function listProducts(req: Request, res: Response): Promise<void> {
  const { category, search, vendor, minPrice, maxPrice, sort } = req.query as {
    category?: string;
    search?: string;
    vendor?: string;
    minPrice?: string;
    maxPrice?: string;
    sort?: string;
  };

  const products = await productRepo.listProducts(req.user!.orgUID, {
    category,
    search,
    brand: vendor,
    minPrice: minPrice ? Number(minPrice) : undefined,
    maxPrice: maxPrice ? Number(maxPrice) : undefined,
    sort,
  });
  res.status(200).json({ products });
}

export async function listCategories(req: Request, res: Response): Promise<void> {
  const categories = await productRepo.listCategories(req.user!.orgUID);
  res.status(200).json({ categories });
}

export async function listVendors(req: Request, res: Response): Promise<void> {
  const vendors = await productRepo.listBrands(req.user!.orgUID);
  res.status(200).json({ vendors });
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  const productUID = Number(req.params.id);
  const orgUID = Number(req.query.orgId);

  if (Number.isNaN(productUID) || Number.isNaN(orgUID)) {
    res.status(400).json({ message: "A valid product id (path) and orgId (query) are required" });
    return;
  }

  const product = await productRepo.getProductFullDetail(orgUID, productUID);
  if (!product) {
    res.status(404).json({ message: "Product not found" });
    return;
  }
  res.status(200).json({ product });
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  const { name, description, price, mrp, stock, categoryUID } = req.body as {
    name: string;
    description?: string;
    price: number;
    mrp?: number;
    stock: number;
    categoryUID?: number;
  };

  if (!name || price === undefined || stock === undefined) {
    res.status(400).json({ message: "name, price and stock are required" });
    return;
  }

  const product = await productRepo.createProduct(req.user!.orgUID, {
    name,
    description,
    price,
    mrp,
    stock,
    categoryUID,
  });
  res.status(201).json({ product });
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const productUID = Number(req.params.id);
  if (Number.isNaN(productUID)) {
    res.status(400).json({ message: "Invalid product id" });
    return;
  }

  const product = await productRepo.updateProduct(req.user!.orgUID, productUID, req.body);
  if (!product) {
    res.status(404).json({ message: "Product not found" });
    return;
  }
  res.status(200).json({ product });
}

export async function deleteProduct(req: Request, res: Response): Promise<void> {
  const productUID = Number(req.params.id);
  if (Number.isNaN(productUID)) {
    res.status(400).json({ message: "Invalid product id" });
    return;
  }

  const deleted = await productRepo.deleteProduct(req.user!.orgUID, productUID);
  if (!deleted) {
    res.status(404).json({ message: "Product not found" });
    return;
  }
  res.status(200).json({ message: "Product deleted" });
}
