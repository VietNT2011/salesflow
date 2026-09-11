import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { apiRequest } from '../../api/client.js';

export function WebchatPage() {
  const { publicId = '' } = useParams();
  const visitorId = useMemo(() => crypto.randomUUID(), []);
  const [messages, setMessages] = useState<string[]>([]);
  async function send(formData: FormData) {
    const message = String(formData.get('message') ?? '');
    await apiRequest(`/public/webchat/${publicId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        visitorId,
        message,
        name: formData.get('name') || undefined,
        email: formData.get('email') || undefined,
      }),
    });
    setMessages((current) => [...current, message]);
  }
  return (
    <main className="centered-page">
      <section className="auth-card webchat-card">
        <p className="eyebrow">SalesFlow webchat</p>
        <h2>Chúng tôi có thể giúp gì?</h2>
        <div className="chat-preview">
          {messages.map((message, index) => (
            <p key={`${message}-${index}`}>{message}</p>
          ))}
        </div>
        <form action={send} className="workspace-form">
          <label>
            Tên
            <input name="name" />
          </label>
          <label>
            Email
            <input name="email" type="email" />
          </label>
          <label>
            Tin nhắn
            <textarea name="message" required />
          </label>
          <button>Gửi tin nhắn</button>
        </form>
      </section>
    </main>
  );
}
