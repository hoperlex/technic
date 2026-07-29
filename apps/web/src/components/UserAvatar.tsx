import { Avatar, type AvatarProps, Tooltip } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { avatarColor, getInitials } from '../utils/avatar';

/** Аватар пользователя: цветной кружок с инициалами (CSS, без картинок). */
export function UserAvatar({ name, size }: { name?: string | null; size?: AvatarProps['size'] }) {
  const trimmed = name?.trim();
  if (!trimmed) return <Avatar size={size} icon={<UserOutlined />} />;
  return (
    <Tooltip title={trimmed}>
      <Avatar
        size={size}
        style={{ backgroundColor: avatarColor(trimmed), color: '#fff', flex: '0 0 auto' }}
      >
        {getInitials(trimmed)}
      </Avatar>
    </Tooltip>
  );
}
