import { Injectable, NotFoundException } from "@nestjs/common";
import { ProductsRepository } from "./products.repository";
import { ListProductsQueryDto } from "./dto/list-products-query.dto";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";

@Injectable()
export class ProductsService {
  constructor(private readonly productsRepository: ProductsRepository) {}

  async listProducts(query: ListProductsQueryDto) {
    const products = await this.productsRepository.listProducts(query.orgId, {
      category: query.category,
      search: query.search,
      brand: query.vendor,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
      sort: query.sort,
    });
    return { products };
  }

  async listCategories(orgUID: number) {
    const categories = await this.productsRepository.listCategories(orgUID);
    return { categories };
  }

  async listVendors(orgUID: number) {
    const vendors = await this.productsRepository.listBrands(orgUID);
    return { vendors };
  }

  async getProduct(orgId: number, productUID: number) {
    const product = await this.productsRepository.getProductFullDetail(orgId, productUID);
    if (!product) {
      throw new NotFoundException("Product not found");
    }
    return { product };
  }

  async createProduct(orgUID: number, dto: CreateProductDto) {
    const product = await this.productsRepository.createProduct(orgUID, dto);
    return { product };
  }

  async updateProduct(orgUID: number, productUID: number, dto: UpdateProductDto) {
    const product = await this.productsRepository.updateProduct(orgUID, productUID, dto);
    if (!product) {
      throw new NotFoundException("Product not found");
    }
    return { product };
  }

  async deleteProduct(orgUID: number, productUID: number) {
    const deleted = await this.productsRepository.deleteProduct(orgUID, productUID);
    if (!deleted) {
      throw new NotFoundException("Product not found");
    }
    return { message: "Product deleted" };
  }
}
