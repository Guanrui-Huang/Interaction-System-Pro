import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '../features/login/LoginPage';

vi.mock('../components/FloatingLines/FloatingLines.jsx', () => ({
  default: () => <div />,
}));

it('enters the dashboard without authentication when the user selects enter', async () => {
  const onEnter = vi.fn();
  const user = userEvent.setup();

  render(<LoginPage onEnter={onEnter} />);

  expect(screen.getByTestId('floating-lines-background')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '智慧污水处理厂' })).toBeInTheDocument();
  expect(screen.getByLabelText('账号')).toBeInTheDocument();
  expect(screen.getByLabelText('密码')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '进入智慧中枢' }));

  expect(onEnter).toHaveBeenCalledOnce();
});
