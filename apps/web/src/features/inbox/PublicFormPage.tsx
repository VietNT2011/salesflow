import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { apiRequest } from '../../api/client.js';

interface Field {
  key: 'name' | 'email' | 'phone' | 'message';
  label: string;
  required: boolean;
}
interface PublicForm {
  name: string;
  fields: Field[];
  consentText: string | null;
}

export function PublicFormPage() {
  const { publicId = '' } = useParams();
  const [sent, setSent] = useState(false);
  const form = useQuery({
    queryKey: ['public-form', publicId],
    queryFn: () => apiRequest<{ data: PublicForm }>(`/public/forms/${publicId}`),
  });
  async function submit(data: FormData) {
    await apiRequest(`/public/forms/${publicId}/submissions`, {
      method: 'POST',
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        name: data.get('name') || undefined,
        email: data.get('email') || undefined,
        phone: data.get('phone') || undefined,
        message: data.get('message') || undefined,
        website: data.get('website') || undefined,
        consent: data.get('consent') === 'on',
        landingPage: window.location.href,
        referrer: document.referrer || undefined,
        utm: {},
      }),
    });
    setSent(true);
  }
  return (
    <main className="centered-page">
      <section className="auth-card">
        <p className="eyebrow">SalesFlow website form</p>
        <h2>{form.data?.data.name ?? 'Liên hệ với chúng tôi'}</h2>
        {sent ? (
          <p role="status">Đã nhận thông tin. Chúng tôi sẽ phản hồi sớm.</p>
        ) : (
          <form action={submit} className="workspace-form">
            {(form.data?.data.fields ?? []).map((field) => (
              <label key={field.key}>
                {field.label}
                {field.key === 'message' ? (
                  <textarea name={field.key} required={field.required} />
                ) : (
                  <input
                    name={field.key}
                    type={field.key === 'email' ? 'email' : 'text'}
                    required={field.required}
                  />
                )}
              </label>
            ))}
            <input className="honeypot" name="website" tabIndex={-1} autoComplete="off" />
            {form.data?.data.consentText && (
              <label>
                <input type="checkbox" name="consent" required /> {form.data.data.consentText}
              </label>
            )}
            <button>Gửi thông tin</button>
          </form>
        )}
      </section>
    </main>
  );
}
