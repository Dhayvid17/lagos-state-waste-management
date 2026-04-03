"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LagosLGA = exports.NatsEvents = exports.Theme = exports.Gender = exports.KycStatus = exports.WasteType = exports.ReportStatus = exports.Permission = exports.UserStatus = exports.UserRole = void 0;
var UserRole;
(function (UserRole) {
    UserRole["CITIZEN"] = "CITIZEN";
    UserRole["COLLECTOR"] = "COLLECTOR";
    UserRole["AGENCY_ADMIN"] = "AGENCY_ADMIN";
    UserRole["SYS_ADMIN"] = "SYS_ADMIN";
})(UserRole || (exports.UserRole = UserRole = {}));
var UserStatus;
(function (UserStatus) {
    UserStatus["ACTIVE"] = "ACTIVE";
    UserStatus["INACTIVE"] = "INACTIVE";
    UserStatus["SUSPENDED"] = "SUSPENDED";
    UserStatus["BLOCKED"] = "BLOCKED";
})(UserStatus || (exports.UserStatus = UserStatus = {}));
var Permission;
(function (Permission) {
    Permission["READ_OWN_REPORTS"] = "read:own_reports";
    Permission["WRITE_REPORTS"] = "write:reports";
    Permission["READ_ASSIGNED_ROUTES"] = "read:assigned_routes";
    Permission["EXECUTE_ROUTE"] = "execute:route_completion";
    Permission["READ_LGA_REPORTS"] = "read:lga_reports";
    Permission["VERIFY_REPORT"] = "execute:verify_report";
    Permission["READ_AUDIT_LOGS"] = "read:audit_logs";
    Permission["BAN_USER"] = "execute:ban_user";
    Permission["ADMIN_ALL"] = "admin:all";
})(Permission || (exports.Permission = Permission = {}));
var ReportStatus;
(function (ReportStatus) {
    ReportStatus["PENDING"] = "PENDING";
    ReportStatus["VERIFIED"] = "VERIFIED";
    ReportStatus["ASSIGNED"] = "ASSIGNED";
    ReportStatus["COMPLETED"] = "COMPLETED";
    ReportStatus["REJECTED"] = "REJECTED";
})(ReportStatus || (exports.ReportStatus = ReportStatus = {}));
var WasteType;
(function (WasteType) {
    WasteType["GENERAL"] = "GENERAL";
    WasteType["RECYCLABLE"] = "RECYCLABLE";
    WasteType["HAZARDOUS"] = "HAZARDOUS";
    WasteType["ORGANIC"] = "ORGANIC";
    WasteType["ELECTRONIC"] = "ELECTRONIC";
})(WasteType || (exports.WasteType = WasteType = {}));
var KycStatus;
(function (KycStatus) {
    KycStatus["NOT_SUBMITTED"] = "NOT_SUBMITTED";
    KycStatus["PENDING"] = "PENDING";
    KycStatus["VERIFIED"] = "VERIFIED";
    KycStatus["REJECTED"] = "REJECTED";
})(KycStatus || (exports.KycStatus = KycStatus = {}));
var Gender;
(function (Gender) {
    Gender["MALE"] = "MALE";
    Gender["FEMALE"] = "FEMALE";
    Gender["OTHER"] = "OTHER";
    Gender["PREFER_NOT_TO_SAY"] = "PREFER_NOT_TO_SAY";
})(Gender || (exports.Gender = Gender = {}));
var Theme;
(function (Theme) {
    Theme["LIGHT"] = "light";
    Theme["DARK"] = "dark";
    Theme["AUTO"] = "auto";
})(Theme || (exports.Theme = Theme = {}));
var NatsEvents;
(function (NatsEvents) {
    NatsEvents["REPORT_CREATED"] = "report.created";
    NatsEvents["REPORT_VERIFIED"] = "report.verified";
    NatsEvents["REPORT_ASSIGNED"] = "report.assigned";
    NatsEvents["REPORT_COMPLETED"] = "report.completed";
    NatsEvents["PAYMENT_SUCCESS"] = "payment.success";
    NatsEvents["PAYMENT_FAILED"] = "payment.failed";
    NatsEvents["USER_CREATED"] = "user.created";
    NatsEvents["USER_BANNED"] = "user.banned";
    NatsEvents["SEND_SMS"] = "notification.send_sms";
    NatsEvents["SEND_EMAIL"] = "notification.send_email";
})(NatsEvents || (exports.NatsEvents = NatsEvents = {}));
var LagosLGA;
(function (LagosLGA) {
    LagosLGA["AGEGE"] = "AGEGE";
    LagosLGA["AJEROMI"] = "AJEROMI";
    LagosLGA["ALIMOSHO"] = "ALIMOSHO";
    LagosLGA["AMUWO_ODOFIN"] = "AMUWO_ODOFIN";
    LagosLGA["APAPA"] = "APAPA";
    LagosLGA["BADAGRY"] = "BADAGRY";
    LagosLGA["EPE"] = "EPE";
    LagosLGA["ETI_OSA"] = "ETI_OSA";
    LagosLGA["IBEJU_LEKKI"] = "IBEJU_LEKKI";
    LagosLGA["IFAKO_IJAIYE"] = "IFAKO_IJAIYE";
    LagosLGA["IKEJA"] = "IKEJA";
    LagosLGA["IKORODU"] = "IKORODU";
    LagosLGA["KOSOFE"] = "KOSOFE";
    LagosLGA["LAGOS_ISLAND"] = "LAGOS_ISLAND";
    LagosLGA["LAGOS_MAINLAND"] = "LAGOS_MAINLAND";
    LagosLGA["MUSHIN"] = "MUSHIN";
    LagosLGA["OJO"] = "OJO";
    LagosLGA["OSHODI_ISOLO"] = "OSHODI_ISOLO";
    LagosLGA["SHOMOLU"] = "SHOMOLU";
    LagosLGA["SURULERE"] = "SURULERE";
})(LagosLGA || (exports.LagosLGA = LagosLGA = {}));
//# sourceMappingURL=index.js.map