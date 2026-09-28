/**
 * Public entry of the widget: outside code takes `@widgets/app-update-banner`, never the module
 * inside. The banner is a widget and not a shared control because it decides WHEN to speak: it
 * watches the version the server reports and asks a person to reload the tab. That decision belongs
 * to the application's own furniture, while a shared control would be a button somebody else drives.
 */
export { AppUpdateBanner } from './ui/AppUpdateBanner';
