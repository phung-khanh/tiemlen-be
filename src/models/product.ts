export interface Product {
  id: string;
  name: string;
  sku: string;
  description: string;
  categoryId: string | null;
  category: string | null;
  price: number;
  image: string;
  stockQuantity: number;
  reorderThreshold: number;
  isBestSeller: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductInput {
  name: string;
  sku: string;
  description?: string;
  category?: string;
  price: number;
  image?: string;
  stockQuantity?: number;
  reorderThreshold?: number;
  isBestSeller?: boolean;
  isActive?: boolean;
}
