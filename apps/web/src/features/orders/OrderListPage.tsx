import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ApiClientError, apiRequest } from '../../api/client.js';

interface Workspace {
  id: string;
  name: string;
  role: string;
}

interface Product {
  id: string;
  sku: string;
  name: string;
  active: boolean;
  defaultPriceMinor: number;
  currency: string;
  version: number;
}

interface Customer {
  id: string;
  displayName: string | null;
  organizationName: string | null;
}

interface Order {
  id: string;
  customerId: string;
  status: string;
  totalMinor: number;
  currency: string;
  placedAt: string;
}

const money = (minor: number, currency: string) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency }).format(
    currency === 'VND' ? minor : minor / 100,
  );

export function OrderListPage() {
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const workspaces = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiRequest<{ data: Workspace[] }>('/workspaces'),
  });
  const workspace = workspaces.data?.data[0];
  const products = useQuery({
    queryKey: ['products', workspace?.id],
    enabled: Boolean(workspace),
    queryFn: () => apiRequest<{ data: Product[] }>(`/workspaces/${workspace?.id}/products`),
  });
  const customers = useQuery({
    queryKey: ['customers', workspace?.id, 'order-picker'],
    enabled: Boolean(workspace),
    queryFn: () =>
      apiRequest<{ data: Customer[] }>(`/workspaces/${workspace?.id}/customers?limit=100`),
  });
  const orders = useQuery({
    queryKey: ['orders', workspace?.id],
    enabled: Boolean(workspace),
    queryFn: () => apiRequest<{ data: Order[] }>(`/workspaces/${workspace?.id}/orders?limit=100`),
  });

  async function createProduct(formData: FormData) {
    if (!workspace) return;
    try {
      await apiRequest(`/workspaces/${workspace.id}/products`, {
        method: 'POST',
        body: JSON.stringify({
          sku: formData.get('sku'),
          name: formData.get('name'),
          defaultPriceMinor: Number(formData.get('defaultPriceMinor')),
          currency: formData.get('currency'),
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ['products', workspace.id] });
      setMessage('Đã thêm sản phẩm.');
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể thêm sản phẩm');
    }
  }

  async function createOrder(formData: FormData) {
    if (!workspace) return;
    try {
      await apiRequest(`/workspaces/${workspace.id}/orders`, {
        method: 'POST',
        body: JSON.stringify({
          customerId: formData.get('customerId'),
          status: formData.get('status'),
          currency: formData.get('currency'),
          discountMinor: Number(formData.get('discountMinor') ?? 0),
          lines: [
            {
              productId: formData.get('productId'),
              quantity: Number(formData.get('quantity')),
            },
          ],
        }),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders', workspace.id] }),
        queryClient.invalidateQueries({ queryKey: ['customers', workspace.id] }),
      ]);
      setMessage('Đã tạo đơn hàng.');
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể tạo đơn hàng');
    }
  }

  async function toggleProduct(product: Product) {
    if (!workspace) return;
    try {
      await apiRequest(`/workspaces/${workspace.id}/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: product.version, active: !product.active }),
      });
      await queryClient.invalidateQueries({ queryKey: ['products', workspace.id] });
      setMessage(product.active ? 'Đã ngừng sản phẩm.' : 'Đã kích hoạt sản phẩm.');
    } catch (cause) {
      setMessage(cause instanceof ApiClientError ? cause.message : 'Không thể cập nhật sản phẩm');
    }
  }

  if (!workspace) {
    return (
      <section>
        <p className="eyebrow">Order history</p>
        <h1>Chưa có workspace.</h1>
      </section>
    );
  }

  const activeProducts = products.data?.data.filter((product) => product.active) ?? [];
  return (
    <section className="customer-page">
      <div className="customer-heading">
        <div>
          <p className="eyebrow">{workspace.name} · CRM orders</p>
          <h1>Đơn hàng.</h1>
        </div>
      </div>
      <div className="customer-grid">
        <div className="customer-list">
          {orders.data?.data.map((order) => (
            <Link key={order.id} to={`/orders/${order.id}`}>
              <span className={`lifecycle lifecycle-${order.status.toLowerCase()}`}>
                {order.status}
              </span>
              <h2>{money(order.totalMinor, order.currency)}</h2>
              <p>
                {customers.data?.data.find((item) => item.id === order.customerId)?.displayName}
              </p>
              <small>{new Date(order.placedAt).toLocaleString('vi-VN')}</small>
            </Link>
          ))}
          {!orders.isLoading && !orders.data?.data.length && <p>Chưa có đơn hàng.</p>}
        </div>
        <div>
          {workspace.role !== 'VIEWER' && workspace.role !== 'AGENT' && (
            <form className="settings-form" action={createOrder}>
              <h2>Tạo đơn thủ công</h2>
              <label>
                Khách hàng
                <select name="customerId" required>
                  <option value="">Chọn khách hàng</option>
                  {customers.data?.data.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.displayName ?? customer.organizationName ?? customer.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Sản phẩm
                <select name="productId" required>
                  <option value="">Chọn sản phẩm</option>
                  {activeProducts.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.sku} · {product.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Số lượng
                <input name="quantity" type="number" min="1" defaultValue="1" required />
              </label>
              <label>
                Giảm giá (minor unit)
                <input name="discountMinor" type="number" min="0" defaultValue="0" required />
              </label>
              <label>
                Tiền tệ
                <input name="currency" defaultValue="VND" maxLength={3} required />
              </label>
              <label>
                Trạng thái ban đầu
                <select name="status">
                  <option>DRAFT</option>
                  <option>CONFIRMED</option>
                </select>
              </label>
              <button type="submit">Tạo đơn hàng</button>
            </form>
          )}
          {(workspace.role === 'OWNER' || workspace.role === 'ADMIN') && (
            <>
              <form className="settings-form" action={createProduct}>
                <h2>Thêm sản phẩm</h2>
                <label>
                  SKU
                  <input name="sku" required />
                </label>
                <label>
                  Tên
                  <input name="name" required />
                </label>
                <label>
                  Giá mặc định (minor unit)
                  <input name="defaultPriceMinor" type="number" min="0" required />
                </label>
                <label>
                  Tiền tệ
                  <input name="currency" defaultValue="VND" maxLength={3} required />
                </label>
                <button type="submit">Thêm vào catalog</button>
              </form>
              <div className="contact-list">
                {products.data?.data.map((product) => (
                  <div key={product.id}>
                    <span>{product.sku}</span>
                    <strong>{product.name}</strong>
                    <small>{money(product.defaultPriceMinor, product.currency)}</small>
                    <button type="button" onClick={() => void toggleProduct(product)}>
                      {product.active ? 'Ngừng dùng' : 'Kích hoạt'}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          {message && <p role="status">{message}</p>}
        </div>
      </div>
    </section>
  );
}
