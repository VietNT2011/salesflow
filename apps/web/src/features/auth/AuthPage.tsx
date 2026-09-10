import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { apiRequest, ApiClientError } from '../../api/client.js';

const authSchema = z.object({
  email: z.string().email('Email không hợp lệ'),
  password: z.string().min(12, 'Mật khẩu cần ít nhất 12 ký tự'),
  displayName: z.string().optional(),
});
type AuthValues = z.infer<typeof authSchema>;

export function AuthPage() {
  const [registering, setRegistering] = useState(false);
  const [serverError, setServerError] = useState('');
  const navigate = useNavigate();
  const form = useForm<AuthValues>({
    resolver: zodResolver(authSchema),
    defaultValues: { email: '', password: '', displayName: '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setServerError('');
    if (registering && (!values.displayName || values.displayName.trim().length < 2)) {
      form.setError('displayName', { message: 'Tên cần ít nhất 2 ký tự' });
      return;
    }
    try {
      await apiRequest(registering ? '/auth/register' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify(
          registering ? values : { email: values.email, password: values.password },
        ),
      });
      await navigate('/onboarding');
    } catch (error) {
      setServerError(error instanceof ApiClientError ? error.message : 'Không thể kết nối máy chủ');
    }
  });

  return (
    <main className="auth-shell">
      <section className="auth-story">
        <p className="eyebrow">SalesFlow CRM</p>
        <h1>Mỗi khách hàng là một câu chuyện liền mạch.</h1>
        <p>Đơn hàng, hội thoại, ticket và việc chăm sóc — cùng một nơi.</p>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <p className="eyebrow">{registering ? 'Tạo tài khoản' : 'Chào mừng trở lại'}</p>
          <h2>{registering ? 'Bắt đầu workspace mới' : 'Đăng nhập SalesFlow'}</h2>
          <form onSubmit={submit}>
            {registering && (
              <label>
                Họ tên
                <input autoComplete="name" {...form.register('displayName')} />
                <small>{form.formState.errors.displayName?.message}</small>
              </label>
            )}
            <label>
              Email
              <input type="email" autoComplete="email" {...form.register('email')} />
              <small>{form.formState.errors.email?.message}</small>
            </label>
            <label>
              Mật khẩu
              <input
                type="password"
                autoComplete={registering ? 'new-password' : 'current-password'}
                {...form.register('password')}
              />
              <small>{form.formState.errors.password?.message}</small>
            </label>
            {serverError && (
              <p role="alert" className="form-error">
                {serverError}
              </p>
            )}
            <button disabled={form.formState.isSubmitting} type="submit">
              {form.formState.isSubmitting
                ? 'Đang xử lý…'
                : registering
                  ? 'Tạo tài khoản'
                  : 'Đăng nhập'}
            </button>
          </form>
          <button
            className="text-button"
            type="button"
            onClick={() => setRegistering((value) => !value)}
          >
            {registering ? 'Đã có tài khoản? Đăng nhập' : 'Chưa có tài khoản? Đăng ký'}
          </button>
        </div>
      </section>
    </main>
  );
}
